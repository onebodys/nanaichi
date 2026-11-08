import Foundation
import NanaichiAccount
import NanaichiDevice
import NanaichiDomain

/// アプリと記録先が読む時計。通知の予約のために、ドメインの時刻を実際の時計の時刻に戻せる
struct AppClock: Sendable {
    let now: @Sendable () -> Instant
    /// ドメインの時刻 `instant` に当たる、実際の時計の時刻
    let wallDate: @Sendable (Instant) -> Date

    static let system = AppClock(
        now: DeviceBackend.systemClock,
        wallDate: { Date(timeIntervalSince1970: Double($0.milliseconds) / 1000) })
}

/// 起動のしかた。リリースのビルドでは、いつも実際の時計とアプリのコンテナの記録と、本番のアカウントを使う
struct LaunchConfiguration {
    let clock: AppClock
    let database: DeviceDatabaseLocation
    let accounts: AccountGateway

    static func current() -> LaunchConfiguration {
        #if DEBUG
            if let debug = debugConfiguration(ProcessInfo.processInfo.environment) { return debug }
        #endif
        return LaunchConfiguration(
            clock: .system, database: .file(databaseURL(named: "device.sqlite")),
            accounts: .live(clock: .system, tokens: keychain))
    }

    /// トークンはログインの Keychain に置く。チームのない署名（ADR 0028）では Data Protection Keychain を使えないため
    static let keychain = KeychainTokenStore(service: AccountGateway.keychainService, keychain: .fileBased)

    /// アプリのコンテナの Application Support にある記録のファイル（サンドボックスの中）
    static func databaseURL(named name: String) -> URL {
        let directory = URL.applicationSupportDirectory.appending(path: "nanaichi", directoryHint: .isDirectory)
        // 作れなければ、記録先が開くときに保存の失敗として画面に出る
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appending(path: name)
    }
}

#if DEBUG
    /// XCUITest が1ラウンドを数秒で進め、ほかの記録と混ざらない記録で動かすための起動のしかた。
    /// デバッグのビルドにだけある（リリースのビルドは環境変数を読まない）
    ///
    /// - `NANAICHI_TIME_SCALE`: 時計を何倍の速さで進めるか
    /// - `NANAICHI_TIME_ORIGIN`: 速さを変える起点（UNIX エポックからのミリ秒）。開き直しても時刻が続くよう、
    ///   テストが同じ値を渡す。なければ起動した時刻
    /// - `NANAICHI_DATABASE`: 記録のファイル名（Application Support/nanaichi の中）。`:memory:` なら残さない
    /// - `NANAICHI_RESET_DATABASE`: `1` なら、開く前にそのファイルを消す
    /// - `NANAICHI_RESET_DEFAULTS`: `1` なら、端末ごとの設定（知らせ方・テーマ・送信キー・つけたままのタグ）を初期に戻す
    /// - `NANAICHI_ACCOUNT_STUB`: `1` なら、サーバーに繋がない代わりのアカウントにログインした状態で開く。
    ///   ログインもブラウザを開かずにすぐ通る。そうでなければ本番にログインするが、トークンはメモリにだけ置き、
    ///   開発者の Keychain のトークンでテストを動かさない
    extension LaunchConfiguration {
        fileprivate static func debugConfiguration(_ environment: [String: String]) -> LaunchConfiguration? {
            let scale = environment["NANAICHI_TIME_SCALE"].flatMap(Double.init)
            let name = environment["NANAICHI_DATABASE"]
            let stub = environment["NANAICHI_ACCOUNT_STUB"] == "1"
            guard scale != nil || name != nil || stub else { return nil }

            let clock =
                scale.map { scale in
                    let origin = environment["NANAICHI_TIME_ORIGIN"].flatMap(Int64.init).map(Instant.init(milliseconds:))
                    return AppClock.scaled(by: scale, from: origin ?? AppClock.system.now())
                } ?? .system
            let database: DeviceDatabaseLocation =
                switch name {
                case ":memory:": .inMemory
                case let name?: .file(databaseURL(named: name))
                case nil: .file(databaseURL(named: "device.sqlite"))
                }
            if environment["NANAICHI_RESET_DEFAULTS"] == "1", let domain = Bundle.main.bundleIdentifier {
                UserDefaults.standard.removePersistentDomain(forName: domain)
            }
            if environment["NANAICHI_RESET_DATABASE"] == "1", case .file(let url) = database {
                for suffix in ["", "-wal", "-shm"] {
                    try? FileManager.default.removeItem(at: URL(filePath: url.path + suffix))
                }
            }
            let accounts: AccountGateway =
                stub ? .stub(clock: clock) : .live(clock: clock, tokens: InMemoryTokenStore())
            return LaunchConfiguration(clock: clock, database: database, accounts: accounts)
        }
    }

    extension AccountGateway {
        /// サーバーの代わりに、メモリのこの端末の記録先をアカウントの記録先として使う。UI テストがアカウントの画面を撮るため
        fileprivate static func stub(clock: AppClock) -> AccountGateway {
            @Sendable func signedIn() -> SignedIn {
                SignedIn(
                    backend: DeviceBackend(location: .inMemory, clock: clock.now),
                    user: { .success(AccountUser(name: "nanaichi のテスト", email: Sensitive("owner@example.com"))) },
                    signOut: {}, forget: {})
            }
            return AccountGateway(restore: { _ in .signedIn(signedIn()) }, signIn: { _ in .signedIn(signedIn()) })
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

    extension AppClock {
        /// `origin` から `scale` 倍の速さで進む時計
        fileprivate static func scaled(by scale: Double, from origin: Instant) -> AppClock {
            AppClock(
                now: {
                    let real = AppClock.system.now()
                    return origin.adding(milliseconds: Int64(Double(real.milliseconds(since: origin)) * scale))
                },
                wallDate: { instant in
                    AppClock.system.wallDate(
                        origin.adding(milliseconds: Int64(Double(instant.milliseconds(since: origin)) / scale)))
                })
        }
    }
#endif
