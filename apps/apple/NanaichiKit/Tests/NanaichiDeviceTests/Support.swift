import Foundation
import GRDB
import Synchronization
import Testing

@testable import NanaichiDevice
@testable import NanaichiDomain

let T0 = Instant(iso8601: "2026-11-02T09:00:00.000Z")!
let minute: Int64 = 60_000
let day: Int64 = 24 * 60 * minute

func at(_ minutes: Int64, _ seconds: Int64 = 0) -> Instant {
    T0.adding(milliseconds: minutes * minute + seconds * 1000)
}

func uuid() -> String { UUID().uuidString.lowercased() }
func eventId() -> SessionEventId { SessionEventId(uuid())! }
func entryId() -> JournalEntryId { JournalEntryId(uuid())! }
func sessionId() -> SessionId { SessionId(uuid())! }
func tag(_ name: String) -> TagName { TagName(name)! }
func tags(_ names: [String]) -> [TagName] { names.map(tag) }

let tokyo = TimeZoneName("Asia/Tokyo")!

func mode(_ focusToJournal: AdvanceChoice, _ journalToFocus: AdvanceChoice) -> AdvanceMode {
    AdvanceMode(
        focusToJournal: focusToJournal, journalToFocus: journalToFocus, journalToBreak: .auto, breakToFocus: .auto)
}

struct ExpectedFailure: Error {}

/// 失敗するはずの結果の失敗を取り出す
func failed<Value, Failure>(_ result: Result<Value, Failure>) throws -> Failure {
    switch result {
    case .success:
        Issue.record("失敗するはずが成功した")
        throw ExpectedFailure()
    case .failure(let error):
        return error
    }
}

struct NotInSession: Error {}

func inSession(_ snapshot: SessionSnapshot) throws -> (session: Session, state: TimerState) {
    guard case .session(_, let session, let state) = snapshot else { throw NotInSession() }
    return (session, state)
}

/// 空の SQLite の記録先を用意し、1つの書き込みのトランザクションの中で場面を1つ動かす
func freshStore(_ scene: (SQLiteRecords) throws -> Void) throws {
    let database = try DatabaseQueue()
    try DeviceSchema.migrator.migrate(database)
    try database.write { db in try scene(SQLiteRecords(db: db)) }
}

/// 進めたり戻したりできる端末の時計
final class TestClock: Sendable {
    private let current: Mutex<Instant>

    init(_ start: Instant = T0) { current = Mutex(start) }

    var now: Instant { current.withLock { $0 } }

    func advance(_ milliseconds: Int64) { current.withLock { $0 = $0.adding(milliseconds: milliseconds) } }
}

/// テストごとの一時ファイルの SQLite
struct TemporaryDatabase: ~Copyable {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("nanaichi-\(uuid()).sqlite")

    func backend(_ clock: TestClock = TestClock()) -> DeviceBackend {
        DeviceBackend(location: .file(url), clock: { clock.now })
    }

    /// 記録先とは別の接続で、ファイルを直接読み書きする（壊す・新しい版にするなど）
    func connection() throws -> DatabaseQueue { try DatabaseQueue(path: url.path) }

    func bytes() throws -> Data { try Data(contentsOf: url) }

    deinit {
        for suffix in ["", "-journal", "-wal", "-shm"] {
            try? FileManager.default.removeItem(at: URL(fileURLWithPath: url.path + suffix))
        }
    }
}
