import AppKit
import Foundation
import Network
import NanaichiAccount
import NanaichiDevice
import NanaichiDomain
import NanaichiPresentation
import Observation

/// スタッツとジャーナル記入の見返しのウィンドウの ID
let reviewWindowId = "review"

/// 1つの記録先につないだ画面の状態。どれも同じ記録先を使い、同期メッセージを受け取り続ける。
/// 記録先を替えるときは、作り直す（Web でページを読み込み直すのと同じ、ADR 0019）
@MainActor
final class AppServices {
    let backend: any Backend
    let timer: TimerModel
    let timeline: TimelineModel
    let tags: TagsModel
    let advanceMode: AdvanceModeModel
    let review: ReviewModel
    /// ToDo。アカウントの記録先でだけあり、この端末の記録先では nil（ADR 0026）
    let tasks: TasksModel?
    let alertSettings: AlertSettingsStore
    let alert: PhaseAlertPlayer

    init(
        backend: any Backend, tasks: (any TaskBackend)?, clock: AppClock, alertSettings: AlertSettingsStore,
        alert: PhaseAlertPlayer
    ) {
        self.backend = backend
        self.alertSettings = alertSettings
        self.alert = alert
        timer = TimerModel(
            backend: backend, clock: clock, alert: alert, notifications: PhaseNotificationScheduler(clock: clock),
            alertSettings: { alertSettings.settings })
        timeline = TimelineModel(backend: backend)
        tags = TagsModel(backend: backend)
        advanceMode = AdvanceModeModel(backend: backend)
        review = ReviewModel(backend: backend)
        self.tasks = tasks.map { TasksModel(backend: backend, api: $0) }
    }

    func run() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.timer.run() }
            group.addTask { await self.timeline.run() }
            group.addTask { await self.tags.run() }
            group.addTask { await self.advanceMode.run() }
            group.addTask { await self.review.run() }
            if let tasks = self.tasks { group.addTask { await tasks.run() } }
        }
    }
}

/// 画面が使う記録先（GLOSSARY）。起動したとき・ログインしたとき・ログアウトしたときにだけ決め直す
enum RecordStore {
    case device
    /// `id` は、どのログインの記録先かの印。ログインが切れた知らせが、前の記録先から遅れて届いても取り違えない
    case account(SignedIn, id: UUID)
}

/// 設定のアカウントの欄の様子
enum AccountStatus {
    case signedOut
    /// ブラウザでログインしている
    case signingIn
    case signedIn(Loadable<AccountUser>)
    case signingOut
}

/// アプリの間ずっと生きている部品。記録先を決め、記録先が替わるたびに画面の状態（`services`）を作り直す。
///
/// 開いている画面の下で記録先を入れ替えない（ADR 0019）。画面は `services` が替わったら作り直すので、
/// 前の記録先の画面の状態は、同期メッセージの受け取りを止めて捨てる
@Observable
@MainActor
final class AppModel {
    private(set) var services: AppServices
    private(set) var account: AccountStatus = .signedOut
    /// アカウントの欄に出す、直前のログイン・ログアウトの失敗や知らせ
    private(set) var accountMessage: String?
    /// ログインが切れて、この Mac の記録先に戻した。メインのウィンドウで知らせる
    var signedOutByExpiry = false
    /// 設定で開いているタブ。メニューの「アカウント…」から、アカウントのタブを開く
    var settingsTab: SettingsTab = .timer

    @ObservationIgnored private let configuration: LaunchConfiguration
    /// この Mac の記録先。ログインしている間も閉じずに持ち、ログアウトしたらまた使う
    @ObservationIgnored private let device: DeviceBackend
    @ObservationIgnored private let alertSettings = AlertSettingsStore()
    @ObservationIgnored private let alert = PhaseAlertPlayer()
    @ObservationIgnored private var recordStore: RecordStore = .device
    @ObservationIgnored private var running: Task<Void, Never>?
    @ObservationIgnored private let network = NWPathMonitor()
    @ObservationIgnored private var online = true

    init(configuration: LaunchConfiguration) {
        self.configuration = configuration
        device = DeviceBackend(location: configuration.database, clock: configuration.clock.now)
        services = AppServices(
            backend: device, tasks: nil, clock: configuration.clock, alertSettings: alertSettings, alert: alert)
        let id = UUID()
        switch configuration.accounts.restore(expiryHandler(for: id)) {
        case .signedOut: break
        case .signedIn(let signedIn): open(.account(signedIn, id: id))
        case .unreadable(let message): accountMessage = message
        }
    }

    /// 記録先の呼び方。記録先ごとの設定に添える
    var recordStoreName: String {
        switch account {
        case .signedOut, .signingIn: "この Mac の記録"
        case .signedIn, .signingOut: "アカウントの記録"
        }
    }

    /// 画面の状態を動かし始め、通信が戻ったら同期の接続を確かめる。アプリが起動したときに1回呼ぶ
    func start() {
        running = Task { [services] in await services.run() }
        network.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in await self?.networkChanged(online: online) }
        }
        network.start(queue: .main)
    }

    private func networkChanged(online: Bool) async {
        let wasOnline = self.online
        self.online = online
        if online, !wasOnline { await checkSyncConnection() }
    }

    /// 今すぐ繋がっているかを確かめる。アプリが前に来たときと、オンラインに戻ったときに呼ぶ
    func checkSyncConnection() async {
        await services.backend.checkSyncConnection()
    }

    // MARK: - 記録先を替える

    /// 記録先を `store` に替え、画面の状態を作り直す
    private func open(_ store: RecordStore) {
        let backend: any Backend
        let tasks: (any TaskBackend)?
        switch store {
        case .device:
            backend = device
            tasks = nil
            account = .signedOut
        case .account(let signedIn, let id):
            backend = signedIn.backend
            tasks = signedIn.tasks
            account = .signedIn(.loading)
            Task { await loadUser(signedIn, id: id) }
        }
        // 起動の途中（`start()` の前）なら、動かし始めるのは `start()` に任せる
        let wasRunning = running != nil
        running?.cancel()
        services.timer.release()
        recordStore = store
        services = AppServices(
            backend: backend, tasks: tasks, clock: configuration.clock, alertSettings: alertSettings, alert: alert)
        if wasRunning { running = Task { [services] in await services.run() } }
    }

    private func loadUser(_ signedIn: SignedIn, id: UUID) async {
        let result = await signedIn.user()
        guard isCurrent(id) else { return }
        account = .signedIn(Loadable.loading.replacing(with: result))
    }

    private func isCurrent(_ id: UUID) -> Bool {
        guard case .account(_, let current) = recordStore else { return false }
        return current == id
    }

    private nonisolated func expiryHandler(for id: UUID) -> @Sendable () -> Void {
        { [weak self] in Task { @MainActor in await self?.expired(id) } }
    }

    /// ログインが切れていた（401）。同時に飛んでいた通信のぶん何回も届くので、まだその記録先にいるときだけ戻す
    private func expired(_ id: UUID) async {
        guard case .account(let signedIn, let current) = recordStore, current == id else { return }
        open(.device)
        accountMessage = "ログインが切れました。もう一度ログインしてください。"
        signedOutByExpiry = true
        await signedIn.forget()
    }

    // MARK: - ログインとログアウト

    /// ブラウザで Google にログインし、アカウントの記録先に替える。
    /// この Mac の記録でセッションの途中なら、ログインに進ませない（ADR 0020、取り込むのは閉じたセッションだけ）
    func signIn() async {
        guard case .device = recordStore, case .signedOut = account else { return }
        if let refusal = signInRefusal() {
            accountMessage = refusal
            return
        }
        accountMessage = nil
        account = .signingIn
        let id = UUID()
        let result = await configuration.accounts.signIn(expiryHandler(for: id))
        switch result {
        case .signedIn(let signedIn):
            // ブラウザでログインしている間に、この Mac でセッションを始めていることがある
            if let refusal = signInRefusal() {
                await signedIn.signOut()
                account = .signedOut
                accountMessage = refusal
            } else {
                open(.account(signedIn, id: id))
            }
        case .cancelled: account = .signedOut
        case .failed(let message):
            account = .signedOut
            accountMessage = message
        }
    }

    /// この Mac の記録でセッションの途中なら、ログインに進ませない理由
    private func signInRefusal() -> String? {
        switch services.timer.view {
        case .noSession, .ended: nil
        case .inSession: "セッションを終えてからログインしてください。"
        case .loading, .loadFailed: "この Mac の記録を読み込めてからログインしてください。"
        }
    }

    /// ログアウトし、この Mac の記録先に戻す。サーバーに届かなくても、手元のトークンは消す
    func signOut() async {
        guard case .account(let signedIn, let id) = recordStore else { return }
        accountMessage = nil
        account = .signingOut
        await signedIn.signOut()
        // 待っている間にログインが切れて、もう戻していることがある
        if isCurrent(id) { open(.device) }
    }
}
