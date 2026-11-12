import Foundation
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

/// 起動のしかた。リリースのビルドでは、いつも実際の時計とアプリのコンテナの記録を使う
struct LaunchConfiguration {
    let clock: AppClock
    let database: DeviceDatabaseLocation

    static func current() -> LaunchConfiguration {
        #if DEBUG
            if let debug = debugConfiguration(ProcessInfo.processInfo.environment) { return debug }
        #endif
        return LaunchConfiguration(clock: .system, database: .file(databaseURL(named: "device.sqlite")))
    }

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
    extension LaunchConfiguration {
        fileprivate static func debugConfiguration(_ environment: [String: String]) -> LaunchConfiguration? {
            let scale = environment["NANAICHI_TIME_SCALE"].flatMap(Double.init)
            let name = environment["NANAICHI_DATABASE"]
            guard scale != nil || name != nil else { return nil }

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
            return LaunchConfiguration(clock: clock, database: database)
        }
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
