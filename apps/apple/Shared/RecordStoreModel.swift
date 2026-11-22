import Foundation
import Network
import NanaichiAccount
import NanaichiDevice
import NanaichiDomain
import NanaichiPresentation
import Observation

/// 1つの記録先につないだ画面の状態。Mac はタイマーのほかにタイムラインやスタッツも持ち（`AppServices`）、
/// iPhone はタイマーだけを持つ（ADR 0031）。記録先を替えるときは作り直す（Web でページを読み込み直すのと同じ、ADR 0019）
@MainActor
protocol RecordStoreServices: AnyObject {
    var backend: any Backend { get }
    var timer: TimerModel { get }
    /// 同期メッセージを受け取り続ける。止めるときはタスクを取り消す
    func run() async
}

/// 画面が使う記録先（GLOSSARY）。起動したとき・ログインしたとき・ログアウトしたときにだけ決め直す
enum RecordStore {
    case device
    /// `id` は、どのログインの記録先かの印。ログインが切れた知らせが、前の記録先から遅れて届いても取り違えない
    case account(SignedIn, id: UUID)
}

/// アカウントの欄の様子
enum AccountStatus {
    case signedOut
    /// ブラウザでログインしている
    case signingIn
    case signedIn(Loadable<AccountUser>)
    case signingOut
}

/// アプリの間ずっと生きている部品。記録先を決め、記録先が替わるたびに画面の状態（`services`）を作り直す。
/// Mac と iPhone で同じものを使う（Issue #71）。
///
/// 開いている画面の下で記録先を入れ替えない（ADR 0019）。画面は `services` が替わったら作り直すので、
/// 前の記録先の画面の状態は、同期メッセージの受け取りを止めて捨てる
@Observable
@MainActor
final class RecordStoreModel<Services: RecordStoreServices> {
    private(set) var services: Services
    private(set) var account: AccountStatus = .signedOut
    /// アカウントの欄に出す、直前のログイン・ログアウトの失敗や知らせ
    private(set) var accountMessage: String?
    /// ログインが切れて、この端末の記録先に戻した。ホームで知らせる
    var signedOutByExpiry = false
    /// ログインしている間の、この端末の記録の取り込み（ADR 0020）。この端末の記録先では nil
    private(set) var importer: ImportModel?
    /// 文言でこの端末を呼ぶ名前
    let thisDevice: ThisDevice

    @ObservationIgnored private let accounts: AccountGateway
    /// この端末の記録先。ログインしている間も閉じずに持ち、ログアウトしたらまた使う
    @ObservationIgnored private let device: DeviceBackend
    @ObservationIgnored private let makeServices: (any Backend, (any TaskBackend)?) -> Services
    @ObservationIgnored private var recordStore: RecordStore = .device
    @ObservationIgnored private var running: Task<Void, Never>?
    @ObservationIgnored private let network = NWPathMonitor()
    @ObservationIgnored private var online = true

    /// 置いてあるトークンから記録先を決める。`makeServices` は記録先（とアカウントの記録先ならタスク）から画面の状態を作る
    init(
        device: DeviceBackend, accounts: AccountGateway, thisDevice: ThisDevice,
        makeServices: @escaping (any Backend, (any TaskBackend)?) -> Services
    ) {
        self.device = device
        self.accounts = accounts
        self.thisDevice = thisDevice
        self.makeServices = makeServices
        services = makeServices(device, nil)
        let id = UUID()
        switch accounts.restore(expiryHandler(for: id)) {
        case .signedOut: break
        // 起動したときにログインしていたなら確かめは出さず、アカウントの欄から取り込める
        case .signedIn(let signedIn): open(.account(signedIn, id: id), askToImport: false)
        case .unreadable(let message): accountMessage = message
        }
    }

    /// 記録先の呼び方。記録先ごとの設定に添える
    var recordStoreName: String {
        switch account {
        case .signedOut, .signingIn: "\(thisDevice.name) の記録"
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

    /// 記録先を `store` に替え、画面の状態を作り直す。`askToImport` なら、ログインした直後として
    /// この端末の記録を取り込むかを確かめる（ADR 0020）
    private func open(_ store: RecordStore, askToImport: Bool = false) {
        let backend: any Backend
        let tasks: (any TaskBackend)?
        switch store {
        case .device:
            backend = device
            tasks = nil
            account = .signedOut
            importer = nil
        case .account(let signedIn, let id):
            backend = signedIn.backend
            tasks = signedIn.tasks
            account = .signedIn(.loading)
            let importer = ImportModel(device: device, account: signedIn, thisDevice: thisDevice, askNow: askToImport)
            self.importer = importer
            Task { await loadUser(signedIn, id: id) }
            Task { await importer.check() }
        }
        // 起動の途中（`start()` の前）なら、動かし始めるのは `start()` に任せる
        let wasRunning = running != nil
        running?.cancel()
        services.timer.release()
        recordStore = store
        services = makeServices(backend, tasks)
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
    /// この端末の記録でセッションの途中なら、ログインに進ませない（ADR 0020、取り込むのは閉じたセッションだけ）
    func signIn() async {
        guard case .device = recordStore, case .signedOut = account else { return }
        if let refusal = signInRefusal() {
            accountMessage = refusal
            return
        }
        accountMessage = nil
        account = .signingIn
        let id = UUID()
        let result = await accounts.signIn(expiryHandler(for: id))
        switch result {
        case .signedIn(let signedIn):
            // ブラウザでログインしている間に、この端末でセッションを始めていることがある
            if let refusal = signInRefusal() {
                await signedIn.signOut()
                account = .signedOut
                accountMessage = refusal
            } else {
                open(.account(signedIn, id: id), askToImport: true)
            }
        case .cancelled: account = .signedOut
        case .failed(let message):
            account = .signedOut
            accountMessage = message
        }
    }

    /// この端末の記録でセッションの途中なら、ログインに進ませない理由
    private func signInRefusal() -> String? {
        switch services.timer.view {
        case .noSession, .ended: nil
        case .inSession: "セッションを終えてからログインしてください。"
        case .loading, .loadFailed: "\(thisDevice.name) の記録を読み込めてからログインしてください。"
        }
    }

    /// ログアウトし、この端末の記録先に戻す。サーバーに届かなくても、手元のトークンは消す
    func signOut() async {
        guard case .account(let signedIn, let id) = recordStore else { return }
        accountMessage = nil
        account = .signingOut
        await signedIn.signOut()
        // 待っている間にログインが切れて、もう戻していることがある
        if isCurrent(id) { open(.device) }
    }
}
