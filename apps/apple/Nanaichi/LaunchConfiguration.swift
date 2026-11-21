import Foundation
import NanaichiAccount
import NanaichiDevice
import NanaichiDomain

/// 起動のしかた。リリースのビルドでは、いつも実際の時計とアプリのコンテナの記録と、本番のアカウントを使う
struct LaunchConfiguration {
    let clock: AppClock
    let database: DeviceDatabaseLocation
    let accounts: AccountGateway

    static func current() -> LaunchConfiguration {
        #if DEBUG
            if let debug = debugConfiguration(ProcessInfo.processInfo.environment) { return debug }
        #endif
        let device = DeviceLaunch.standard
        return LaunchConfiguration(
            clock: device.clock, database: device.database, accounts: .live(clock: device.clock, tokens: keychain))
    }

    /// トークンはログインの Keychain に置く。チームのない署名（ADR 0028）では Data Protection Keychain を使えないため
    static let keychain = KeychainTokenStore(service: AccountGateway.keychainService, keychain: .fileBased)
}

#if DEBUG
    /// XCUITest のための起動のしかた。時計と記録のファイルは `DeviceLaunch.debug` の環境変数で決める。加えて
    ///
    /// - `NANAICHI_ACCOUNT_STUB`: `1` なら、サーバーに繋がない代わりのアカウントにログインした状態で開く。
    ///   ログインもブラウザを開かずにすぐ通る。そうでなければ本番にログインするが、トークンはメモリにだけ置き、
    ///   開発者の Keychain のトークンでテストを動かさない
    extension LaunchConfiguration {
        fileprivate static func debugConfiguration(_ environment: [String: String]) -> LaunchConfiguration? {
            let stub = environment["NANAICHI_ACCOUNT_STUB"] == "1"
            guard let device = DeviceLaunch.debug(environment, requested: stub) else { return nil }
            let accounts: AccountGateway =
                stub ? .stub(clock: device.clock) : .live(clock: device.clock, tokens: InMemoryTokenStore())
            return LaunchConfiguration(clock: device.clock, database: device.database, accounts: accounts)
        }
    }

    extension AccountGateway {
        /// サーバーの代わりに、メモリのこの端末の記録先をアカウントの記録先として使う。UI テストがアカウントの画面を撮るため
        fileprivate static func stub(clock: AppClock) -> AccountGateway {
            @Sendable func signedIn() -> SignedIn {
                SignedIn(
                    backend: DeviceBackend(location: .inMemory, clock: clock.now),
                    tasks: StubTaskBackend(clock: clock.now),
                    user: { .success(AccountUser(name: "nanaichi のテスト", email: Sensitive("owner@example.com"))) },
                    // サーバーの代わりに、どのセッションも取り込んだと答える（アカウントの記録先には書かない）
                    sendImportBatch: { batch in
                        .success(
                            ImportReceipt(
                                outcomes: batch.sessions.map { SessionImportOutcome(sessionId: $0.id, kind: .imported) }))
                    },
                    signOut: {}, forget: {})
            }
            return AccountGateway(restore: { _ in .signedIn(signedIn()) }, signIn: { _ in .signedIn(signedIn()) })
        }
    }

    /// サーバーの代わりに、メモリにタスクと ToDo の設定を置く。ToDo は無効から始まり、ジャーナルから完了したタスクが
    /// 1件ある（判断モデルを呼ばずに、その表示を撮るため）。同期メッセージは送らず、画面は応答で一覧を変える
    private actor StubTaskBackend: TaskBackend {
        private let clock: @Sendable () -> Instant
        private var setting = TaskSetting.default
        private var tasks: [TodoTask]

        init(clock: @escaping @Sendable () -> Instant) {
            self.clock = clock
            let now = clock()
            let drafted = TodoTask.create(
                id: TaskId(UUID().uuidString.lowercased())!, title: TaskTitle("企画書の下書きを書く")!,
                now: now.adding(milliseconds: -3_600_000))
            tasks = [
                .completed(
                    drafted.complete(
                        .fromJournal(
                            entryId: JournalEntryId(UUID().uuidString.lowercased())!, probability: Probability(0.96)!),
                        now: now))
            ]
        }

        func getTaskSetting() async -> Result<TaskSetting, BackendError> { .success(setting) }

        func changeTaskSetting(_ setting: TaskSetting) async -> Result<TaskSetting, BackendError> {
            self.setting = setting
            return .success(setting)
        }

        func getTasks() async -> Result<TaskList, BackendError> { .success(TaskList(tasks: tasks)) }

        func createTask(id: TaskId, title: TaskTitle) async -> Result<TodoTask, BackendError> {
            if let known = tasks.first(where: { $0.id == id }) { return .success(known) }
            let created = TodoTask.open(TodoTask.create(id: id, title: title, now: clock()))
            tasks.append(created)
            return .success(created)
        }

        func renameTask(id: TaskId, title: TaskTitle) async -> Result<TodoTask, BackendError> {
            change(id) { $0.renamed(title, now: $1) }
        }

        func completeTask(id: TaskId) async -> Result<TodoTask, BackendError> {
            change(id) { task, now in
                switch task {
                case .open(let open): .completed(open.complete(.manual, now: now))
                case .completed: task
                }
            }
        }

        func reopenTask(id: TaskId) async -> Result<TodoTask, BackendError> {
            change(id) { task, now in
                switch task {
                case .open: task
                case .completed(let completed): .open(completed.reopen(now: now))
                }
            }
        }

        func deleteTask(id: TaskId) async -> Result<DeletedTask, BackendError> {
            guard tasks.contains(where: { $0.id == id }) else { return .failure(.rejected(.taskNotFound)) }
            tasks.removeAll { $0.id == id }
            return .success(DeletedTask(id: id))
        }

        private func change(_ id: TaskId, _ transform: (TodoTask, Instant) -> TodoTask) -> Result<TodoTask, BackendError> {
            guard let index = tasks.firstIndex(where: { $0.id == id }) else { return .failure(.rejected(.taskNotFound)) }
            tasks[index] = transform(tasks[index], clock())
            return .success(tasks[index])
        }
    }

    /// `NANAICHI_SELF_CHECK=1` で起動したら、ビルドしたアプリ（サンドボックスの中）から、Keychain にトークンを
    /// 置いて読んで消せるかと、本番のサーバーに届くか（ログインしていないので 401）を確かめ、結果を標準出力に書いて終える。
    /// 署名と entitlement が実際のアプリと同じ条件で確かめるため（`swift test` のプロセスはサンドボックスの外）
    func runSelfCheckIfAsked() async {
        guard ProcessInfo.processInfo.environment["NANAICHI_SELF_CHECK"] == "1" else { return }
        let token = SessionToken("self-check-token")!
        let stores: [(String, KeychainTokenStore)] = [
            ("fileBased", KeychainTokenStore(service: "app.nanaichi.mac.self-check", keychain: .fileBased)),
            ("dataProtection", KeychainTokenStore(service: "app.nanaichi.mac.self-check", keychain: .dataProtection)),
        ]
        for (name, store) in stores {
            do {
                try store.save(token)
                let loaded = try store.load()
                try store.delete()
                let afterDelete = try store.load()
                print("keychain \(name): saved, loaded \(loaded == token ? "same" : "different"), deleted \(afterDelete == nil ? "gone" : "still there")")
            } catch {
                print("keychain \(name): failed with OSStatus \(error.status)")
            }
        }
        let backend = AccountBackend(token: SessionToken("not-a-token")!, onSignedOut: {})
        print("server: \(await backend.getMe())")
        exit(0)
    }
#endif
