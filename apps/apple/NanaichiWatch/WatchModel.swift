import Foundation
import NanaichiDomain
import NanaichiPresentation
import NanaichiWatchLink
import Observation

/// Watch の画面の状態と操作（ADR 0031）。
///
/// - iPhone から届いたスナップショットを持ち、刻みごとに Watch の時刻で状態を計算し直す（ADR 0003）
/// - 開始とセッション中の操作は iPhone に頼み、返ってきたスナップショットに置き換える。iPhone に届かないあいだと、
///   届くようになってから今の様子を確かめ終えるまでは頼まない（それまでの表示は古いことがある）
/// - 答えが返らなかった頼みは、今の様子を頼み直して確かめる。同じ記録を見たまま押し直したら、同じ操作イベントの ID で
///   送り直す（`WatchRequest`、ADR 0007）
/// - iPhone の側の変化は、iPhone からの知らせで届く。頼みの答えと知らせは入れ替わって届くので、古いものは捨てる（ADR 0012）
/// - セッション中は、フェーズの切り替わりを振動で知らせる（`PhaseChangeVibrator`、ADR 0033）
@Observable
@MainActor
final class WatchModel {
    private(set) var loading: PhoneSnapshotLoading = .waiting
    private(set) var reach: PhoneReach = .unreachable
    private(set) var deviceNow: Instant
    /// 頼んだ操作の答えを待っている
    private(set) var pending = false
    /// iPhone に届くようになってから、今の様子を確かめ終えていない
    private(set) var syncing = false
    /// 直前の操作の失敗
    private(set) var errorMessage: String?
    let vibrator: PhaseChangeVibrator

    @ObservationIgnored private let link: any PhoneLink
    @ObservationIgnored private let clock: @Sendable () -> Instant
    /// アプリが前にいる（画面に出ている）
    @ObservationIgnored private var active = false
    /// 送って答えが返らなかった頼み。同じ記録を見たまま押し直したら、これを送り直す
    @ObservationIgnored private var unanswered: WatchRequest?
    /// 何度目に今の様子を確かめ始めたか。確かめているあいだに届かなくなってまた届くと、確かめ直す。押せるようにするのは最後に始めたものだけ
    @ObservationIgnored private var syncGeneration = 0

    /// 今の様子を確かめられなかったとき、頼み直すまでの待ちの最初と最長
    private static let syncRetry = (first: Duration.seconds(1), longest: Duration.seconds(30))

    /// 刻みの間隔。表示は秒単位なので、秒の変わり目から遅れても 1/4 秒まで
    private static let tick = Duration.milliseconds(250)

    init(link: any PhoneLink, clock: @escaping @Sendable () -> Instant) {
        self.link = link
        self.clock = clock
        vibrator = PhaseChangeVibrator(link: link, clock: clock)
        deviceNow = clock()
    }

    /// アプリが前に出た・前から外れた（手首を下ろした・ほかのアプリに移った）
    func activeChanged(_ active: Bool) {
        self.active = active
        if active { vibrator.appBecameActive() } else { vibrator.appResignedActive() }
    }

    var face: WatchFace {
        .of(.of(loading.timer, deviceNow: deviceNow), reach: reach, pending: pending || syncing)
    }

    /// iPhone からの知らせを受け取り、刻み続ける。アプリが動いている間ずっと呼んだままにする
    func run() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.receive() }
            group.addTask { await self.keepTicking() }
        }
    }

    private func keepTicking() async {
        while !Task.isCancelled {
            deviceNow = clock()
            let view = TimerView.of(loading.timer, deviceNow: deviceNow)
            vibrator.tick(loading.timer.received, inSession: view.isInSession, deviceNow: deviceNow, appActive: active)
            try? await Task.sleep(for: Self.tick)
        }
    }

    private func receive() async {
        for await event in link.events() {
            switch event {
            case .reach(let reach):
                self.reach = reach
                if reach == .reachable {
                    vibrator.phoneReachable()
                    // 届かなかったあいだの変化は知らせで届くが、届くようになったら今の様子を確かめる。
                    // 届くようになったその場で押せなくする（確かめを待つあいだに押されないように）
                    let generation = beginSync()
                    Task { await sync(generation) }
                }
            case .message(let message):
                handle(message)
            }
        }
    }

    // MARK: - 操作

    func start() { request(.start) }

    func operate(_ kind: SessionOperationKind) { request(.operate(kind)) }

    /// 画面に出している記録を見て `command` を頼む。ボタンを押せないとき（答えを待っている・届かない・確かめている）は頼まない。
    /// ボタンを押せなくするのは描き直したときなので、続けて押されたときもここで二重に送らない
    private func request(_ command: WatchCommand) {
        guard !pending, !syncing, reach == .reachable, case .loaded(let shown) = loading,
            let request = WatchRequest.of(command, shown: shown, unanswered: unanswered, newEventId: newEventId)
        else { return }
        pending = true
        errorMessage = nil
        Task {
            switch await link.ask(request.message) {
            case .snapshot(let snapshot)?:
                unanswered = nil
                apply(snapshot)
            case .refused(let refusal)?:
                unanswered = nil
                errorMessage = refusal
                // iPhone の様子が、Watch の思っているものと違ったのかもしれない（自動終了した・ほかの端末で操作したなど）
                await askCurrent()
            case nil:
                // 届いて記録されたのに、答えだけが返らなかったのかもしれない。今の様子を確かめ、
                // 変わっていなければ（記録されていなければ）押し直したときに同じ ID で送り直す
                unanswered = request
                errorMessage = phoneDidNotAnswerMessage
                if reach == .reachable { await askCurrent() }
            // 受け取っただけの答えは、記録先に通さない頼み（振動で知らせる範囲）にしか返らない
            case .accepted?:
                break
            }
            pending = false
        }
    }

    /// iPhone に届くようになったら、今の様子を確かめ終えるまでボタンを押せなくする。
    /// 届かなかったあいだに置かれていた最新のスナップショット（application context）は、古いことがある
    private func beginSync() -> Int {
        syncGeneration += 1
        syncing = true
        return syncGeneration
    }

    /// 今の様子を読めるまで、待ちを延ばしながら頼み直す。読めたら押せるようにする。
    /// 後から確かめ始めたものがあるか、届かなくなったらやめる（次に届くようになったときに確かめ直す）
    private func sync(_ generation: Int) async {
        var wait = Self.syncRetry.first
        while generation == syncGeneration, reach == .reachable {
            if await askCurrent() {
                if generation == syncGeneration { syncing = false }
                return
            }
            try? await Task.sleep(for: wait)
            wait = min(wait * 2, Self.syncRetry.longest)
        }
    }

    /// 今の様子を頼み、読めたら true。読めなくても操作の失敗ではないので、前に受け取ったものを出し続ける
    @discardableResult
    private func askCurrent() async -> Bool {
        guard case .snapshot(let snapshot)? = await link.ask(.current) else { return false }
        apply(snapshot)
        return true
    }

    /// 直前の操作の失敗を読んだ
    func dismissError() { errorMessage = nil }

    private func handle(_ message: PhoneMessage) {
        switch message {
        case .snapshot(let snapshot): apply(snapshot)
        // 知らせで断られることはない（断るのは頼みへの答えだけ）
        case .refused, .accepted: break
        }
    }

    private func apply(_ snapshot: PhoneSnapshot) {
        loading = loading.applying(snapshot)
        deviceNow = clock()
    }
}

// UUID の文字列は必ず UUID の形なので、読めないのは実装の誤り
private func newEventId() -> SessionEventId { SessionEventId(UUID().uuidString.lowercased())! }
