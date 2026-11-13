import Foundation
import NanaichiDomain
import NanaichiPresentation
import Observation

/// タイマーとジャーナル記入の画面の状態と操作（Web の use-session-timer.ts と use-timeline.ts の書く部分）。
///
/// - 現在のセッションを読み込み、刻みごとに端末の時刻で状態を計算し直す（ADR 0003）
/// - 時間が過ぎてフェーズが切り替わったら音で知らせ、これからの切り替わりは通知に予約しておく
/// - 操作は記録先に送り、返ってきたスナップショットに置き換える。ほかの画面での変更は同期メッセージで届く
///
/// 記録先が `Backend` のどちらの実装かは知らない（ADR 0019「画面は記録先を知らない」）
@Observable
@MainActor
final class TimerModel {
    private(set) var loading: TimerLoading = .loading
    private(set) var deviceNow: Instant
    /// 操作を送っている途中。ボタンを押せなくして、二重に送らないようにする
    private(set) var pending = false
    /// 直前の操作の失敗
    private(set) var errorMessage: String?
    /// 直前の記入の失敗
    private(set) var writeErrorMessage: String?
    private(set) var todayFocus: TodayFocus = .unknown
    /// 終了したセッションの記入の数（セッションのまとめに出す）
    private(set) var endedEntries: EntryCount = .notYetCounted
    /// ジャーナル記入の入力欄にカーソルを置く頼み。増えるたびに置く
    private(set) var journalFocusRequests = 0
    /// メニューバーの表示。値が変わったとき（1秒に1回まで）だけ書き換え、刻みのたびにメニューバーを描き直さない
    private(set) var menuBarLabel = menuBarLabelOf(.loading)

    @ObservationIgnored private let backend: any Backend
    @ObservationIgnored private let clock: AppClock
    @ObservationIgnored private let alert: PhaseAlertPlayer
    @ObservationIgnored private let notifications: PhaseNotificationScheduler
    @ObservationIgnored private let alertSettings: () -> AlertSettings
    @ObservationIgnored private var watch = PhaseChangeWatch()
    /// 書けなかった記入。同じ本文とタグで送り直すときは同じ ID で送り、二重に書かない（ADR 0010）
    @ObservationIgnored private var failedDraft: (id: JournalEntryId, body: String, tags: [TagName])?
    /// 今日の集中時間を読み込み直すかを決める値。完了セットが増えうるときだけ読み込み直す（ADR 0014）
    @ObservationIgnored private var todayFocusKey: StatsRefreshKey?
    @ObservationIgnored private var countedEndedSession: SessionId?
    /// セッション中は App Nap で刻みが遅れないようにする（音が遅れて鳴らないように）
    @ObservationIgnored private var activity: NSObjectProtocol?

    /// 刻みの間隔。表示は秒単位なので、秒の変わり目から遅れても 1/4 秒まで
    private static let tick = Duration.milliseconds(250)

    init(
        backend: any Backend, clock: AppClock, alert: PhaseAlertPlayer, notifications: PhaseNotificationScheduler,
        alertSettings: @escaping () -> AlertSettings
    ) {
        self.backend = backend
        self.clock = clock
        self.alert = alert
        self.notifications = notifications
        self.alertSettings = alertSettings
        deviceNow = clock.now()
    }

    var view: TimerView { .of(loading, deviceNow: deviceNow) }

    /// 時計のずれで補正した、記録先の今の時刻の見積もり
    var serverNow: Instant { loading.received?.serverNow(deviceNow: deviceNow) ?? deviceNow }

    /// スタッツと今日の集中時間を読み込み直すきっかけ。完了セットが増えうるときと日付が変わったときだけ変わる
    var statsRefreshKey: StatsRefreshKey { .of(view, serverNow: serverNow, timeZone: deviceTimeZone()) }

    // MARK: - 動かし続ける

    /// 読み込み、同期メッセージを受け取り、刻み続ける。アプリが動いている間ずっと呼んだままにする
    func run() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.receiveSyncEvents() }
            group.addTask { await self.keepTicking() }
        }
    }

    private func keepTicking() async {
        while !Task.isCancelled {
            advanceClock()
            try? await Task.sleep(for: Self.tick)
        }
    }

    private func receiveSyncEvents() async {
        for await event in await backend.subscribe() {
            switch event {
            // 受け取り始めたとき（繋ぎ直したとき）は、届かなかった変更があるかもしれないので読み込み直す
            // 取り込んだ記録は届かないので、繋ぎ直したときと同じく読み込み直す（ADR 0020、Web と同じ）
            case .connected, .message(.recordsImported): await load()
            case .message(.sessionChanged(let snapshot)):
                // 送った時刻がわからないので、記録先が直前に測った時計のずれを使う
                apply(Received(snapshot: snapshot, offset: await backend.clockOffset()))
            case .message(.journalEntrySaved), .message(.journalEntryDeleted), .message(.tagDeleted),
                .message(.advanceModeChanged), .message(.taskSaved), .message(.taskDeleted),
                .message(.taskSettingChanged):
                // 進め方の変更は sessionChanged もあわせて届く。記入とタグはタイムラインとタグの一覧が受け取る
                break
            }
        }
    }

    private func advanceClock() {
        deviceNow = clock.now()
        let snapshot = loading.received?.snapshot
        let state: TimerState? =
            switch snapshot {
            case .session(_, let session, _): session.stateAt(serverNow)
            case .noSession, nil: nil
            }
        if let to = watch.observe(snapshot, state) {
            alert.play(to: to.kind, settings: alertSettings())
        }
        refreshDerivedCounts()
        refreshMenuBarLabel()
    }

    private func refreshMenuBarLabel() {
        let label = menuBarLabelOf(view)
        if label != menuBarLabel { menuBarLabel = label }
    }

    // MARK: - 記録先とのやり取り

    /// 記録先を呼び、受け取ったスナップショットを、記録先がそのやり取りで測った時計のずれと組にする
    private func receive(_ call: () async -> Result<SessionSnapshot, BackendError>) async
        -> Result<Received, BackendError>
    {
        let result = await call()
        let offset = await backend.clockOffset()
        return result.map { Received(snapshot: $0, offset: offset) }
    }

    private func load() async {
        switch await receive({ await backend.getCurrentSession() }) {
        case .success(let received): apply(received)
        case .failure: loading = loading.failingToLoad()
        }
    }

    /// 届いたスナップショットに置き換え、スナップショットが替わったら通知を予約し直す
    private func apply(_ received: Received) {
        let before = loading.received?.snapshot
        loading = loading.applying(received)
        deviceNow = clock.now()
        refreshMenuBarLabel()
        guard let after = loading.received?.snapshot, after != before else { return }
        scheduleNotifications(for: after, sound: false)
        holdActivity(during: view.isInSession)
        refreshDerivedCounts()
    }

    private func send(_ call: @escaping () async -> Result<SessionSnapshot, BackendError>) {
        pending = true
        errorMessage = nil
        Task {
            switch await receive(call) {
            case .success(let received): apply(received)
            case .failure(let error):
                errorMessage = operationErrorMessageOf(error)
                // 別の画面で操作したなどで食い違っているかもしれないので、今の状態を読み込み直す
                if error != .unreachable { await load() }
            }
            pending = false
        }
    }

    // MARK: - 操作

    func start() {
        // 通知の許可は、開始ボタンを押した操作の中で求める（Web と同じ）
        if alertSettings().notification { notifications.requestAuthorization() }
        let id = newEventId()
        send { [backend] in await backend.startSession(id: id) }
    }

    func operate(_ kind: SessionOperationKind) {
        let id = newEventId()
        send { [backend] in await backend.operateSession(id: id, kind: kind) }
    }

    /// その操作をいまできるか。メニューの項目を押せるかに使う
    func canOperate(_ kind: SessionOperationKind) -> Bool {
        guard !pending, case .inSession(_, _, let operations) = view else { return false }
        return operations.contains(kind)
    }

    var canStart: Bool {
        guard !pending else { return false }
        switch view {
        case .noSession, .ended: return true
        case .loading, .loadFailed, .inSession: return false
        }
    }

    func focusJournal() {
        journalFocusRequests += 1
    }

    func reload() {
        loading = .loading
        Task { await load() }
    }

    /// ジャーナル記入を書く。書けたら true。書くと自動終了の時刻が延びるので、セッションの変更も同期メッセージで届く。
    /// 書いた記入は同期メッセージでタイムラインに届く
    func write(_ body: String, tags: [TagName]) async -> Bool {
        writeErrorMessage = nil
        let id = failedDraft.flatMap { $0.body == body && $0.tags == tags ? $0.id : nil } ?? newEntryId()
        switch await backend.writeJournalEntry(id: id, body: body, tags: tags) {
        case .success:
            failedDraft = nil
            return true
        case .failure(let error):
            failedDraft = (id, body, tags)
            writeErrorMessage = writeErrorMessageOf(error)
            return false
        }
    }

    // MARK: - 通知

    /// 通知を予約し直す。`sound` が true なら知らせ方の音色で鳴らす（アプリが鳴らせなくなるとき）
    private func scheduleNotifications(for snapshot: SessionSnapshot, sound: Bool) {
        let settings = alertSettings()
        notifications.reschedule(
            phaseNotificationPlanOf(snapshot, now: serverNow, settings: settings),
            sound: sound && settings.sound ? settings : nil)
    }

    /// 通知の許可を求める（設定で通知を出すにしたとき）
    func requestNotificationAuthorization() {
        notifications.requestAuthorization()
    }

    /// 知らせ方の設定を変えたら、通知を出すかどうかを予約にも当てる
    func alertSettingsChanged() {
        if let snapshot = loading.received?.snapshot { scheduleNotifications(for: snapshot, sound: false) }
    }

    /// アプリを終了する前に呼ぶ。アプリが音を鳴らせなくなるので、通知の予約を音の鳴るものに入れ替える
    func prepareForTermination() async {
        if let snapshot = loading.received?.snapshot {
            scheduleNotifications(for: snapshot, sound: true)
        }
        await notifications.settle()
    }

    /// 記録先を替えて、このモデルを使わなくなるときに呼ぶ。App Nap を止めたままにしない
    func release() {
        holdActivity(during: false)
    }

    private func holdActivity(during inSession: Bool) {
        switch (inSession, activity) {
        case (true, nil):
            activity = ProcessInfo.processInfo.beginActivity(
                options: .userInitiatedAllowingIdleSystemSleep, reason: "フェーズの切り替わりを時刻どおりに知らせる")
        case (false, let held?):
            ProcessInfo.processInfo.endActivity(held)
            activity = nil
        case (true, .some), (false, nil):
            break
        }
    }

    // MARK: - 今日の集中時間とまとめの記入の数

    private func refreshDerivedCounts() {
        let view = view
        let timeZone = deviceTimeZone()
        let key = statsRefreshKey
        if key != todayFocusKey {
            todayFocusKey = key
            Task {
                switch await backend.getStats(period: .today, timeZone: timeZone) {
                case .success(let report): todayFocus = .counted(completedSets: report.completedSets)
                case .failure: break
                }
            }
        }
        if case .ended(let session, _) = view, countedEndedSession != session.id {
            countedEndedSession = session.id
            endedEntries = .notYetCounted
            Task {
                // 終わったばかりのセッションは、いちばん新しいページの先頭にある
                guard case .success(let page) = await backend.getTimeline(before: nil),
                    let ended = page.sessions.first(where: { $0.session.id == session.id })
                else { return }
                endedEntries = .counted(ended.entries.count)
            }
        }
    }
}

/// 端末のタイムゾーン。読めない名前なら UTC で数える
func deviceTimeZone() -> TimeZoneName {
    TimeZoneName(TimeZone.current.identifier) ?? TimeZoneName("UTC")!
}

// UUID の文字列は必ず UUID の形なので、読めないのは実装の誤り
private func newEventId() -> SessionEventId { SessionEventId(UUID().uuidString.lowercased())! }
private func newEntryId() -> JournalEntryId { JournalEntryId(UUID().uuidString.lowercased())! }
