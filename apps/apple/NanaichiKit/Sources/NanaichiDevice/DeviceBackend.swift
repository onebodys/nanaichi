import Foundation
import GRDB
import NanaichiDomain
import NanaichiWorkflows

/// この端末の記録を置く SQLite のファイル
public enum DeviceDatabaseLocation: Sendable {
    case file(URL)
    /// アプリを閉じると消える。テストとプレビューのため
    case inMemory
}

/// この端末の記録で動く `Backend`（ADR 0019・0028）。UserDO と同じワークフローを SQLite の記録につなぐ。
///
/// アプリの中で1つだけ作り、メニューバーとウィンドウなどの画面で共有する。actor なので、
/// 読み込みから書き込みまでを一度に1つの呼び出しだけが行う（開いているセッションは1つという約束を守る）。
/// 1回の呼び出しは1つの書き込みのトランザクションで、途中で例外が出たら何も書かない。
/// 書いたあとは、UserDO が送るのと同じ同期メッセージを、受け取っているすべての画面へ送る
public actor DeviceBackend: Backend {
    private let location: DeviceDatabaseLocation
    private let clock: @Sendable () -> Instant
    private let newSessionId: @Sendable () -> SessionId
    private var database: DatabaseQueue?
    private var subscribers: [UUID: AsyncStream<SyncEvent>.Continuation] = [:]

    public init(
        location: DeviceDatabaseLocation,
        clock: @escaping @Sendable () -> Instant = DeviceBackend.systemClock,
        newSessionId: @escaping @Sendable () -> SessionId = DeviceBackend.randomSessionId
    ) {
        self.location = location
        self.clock = clock
        self.newSessionId = newSessionId
    }

    public static let systemClock: @Sendable () -> Instant = {
        Instant(milliseconds: Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)))
    }

    public static let randomSessionId: @Sendable () -> SessionId = {
        // UUID の文字列は必ず UUID の形なので、読めないのは実装の誤り
        guard let id = SessionId(UUID().uuidString.lowercased()) else { preconditionFailure("UUID を ID にできない") }
        return id
    }

    // MARK: - 記録を開く

    /// 開いて、まだ当てていないマイグレーションを当てる。開けなければ次の呼び出しでまた開き直す。
    /// 読めないファイルや新しい版のアプリが書いたファイルは、作り直さず、書き換えずにそのまま残す
    private func open() -> Result<DatabaseQueue, BackendError> {
        if let database { return .success(database) }
        do {
            let opened =
                switch location {
                case .file(let url): try DatabaseQueue(path: url.path)
                case .inMemory: try DatabaseQueue()
                }
            let migrator = DeviceSchema.migrator
            if try opened.read(migrator.hasBeenSuperseded) {
                return .failure(.storageFailed(.newerFormat))
            }
            try migrator.migrate(opened)
            database = opened
            return .success(opened)
        } catch {
            return .failure(Self.backendError(of: error))
        }
    }

    private static func backendError(of error: any Error) -> BackendError {
        guard let error = error as? DatabaseError else { return .broken }
        switch error.resultCode {
        case .SQLITE_FULL: return .storageFailed(.quotaExceeded)
        case .SQLITE_CANTOPEN, .SQLITE_PERM, .SQLITE_READONLY, .SQLITE_IOERR, .SQLITE_BUSY, .SQLITE_LOCKED:
            return .storageFailed(.unavailable)
        default: return .broken
        }
    }

    // MARK: - ワークフローを動かす

    /// この端末の記録先が記録に使う時刻。端末の時計が記録済みの時刻より前に戻っていれば、記録済みの時刻を使う（ADR 0019）
    private func deviceNow(_ records: SQLiteRecords) throws -> Instant {
        let now = clock()
        return try records.latestRecordedAt().map { max($0, now) } ?? now
    }

    /// 1つのワークフローを1つの書き込みのトランザクションで動かす。
    ///
    /// alarm がないので、UserDO と違いワークフローの前にも自動終了を確定させる。想定内の失敗でも、
    /// そのとき確定した自動終了は残す。例外が出たらトランザクションを取り消し、何も書かず、何も知らせない
    private func run<Value: Sendable, Failure: WorkflowError>(
        _ command: (SQLiteRecords, Instant) throws -> Result<Executed<Value>, Failure>
    ) -> Result<Value, BackendError> {
        open().flatMap { database in
            let result: Result<Executed<Value>, Failure>
            do {
                result = try database.write { db in
                    let records = SQLiteRecords(db: db)
                    let now = try deviceNow(records)
                    _ = try loadOpenSession(records, now: now)
                    let result = try command(records, now)
                    _ = try loadOpenSession(records, now: now)
                    return result
                }
            } catch {
                return .failure(Self.backendError(of: error))
            }
            return result.mapError { .rejected($0.rejectionCode) }.map { executed in
                deliver(executed.messages)
                return executed.value
            }
        }
    }

    private func read<Value: Sendable>(_ query: (SQLiteRecords, Instant) throws -> Value) -> Result<Value, BackendError> {
        run { records, now in Result<Executed<Value>, Never>.success(.read(try query(records, now))) }
    }

    // MARK: - Backend

    public func getCurrentSession() -> Result<SessionSnapshot, BackendError> {
        read { records, now in try NanaichiWorkflows.getCurrentSession(records, now: now) }
    }

    public func startSession(id: SessionEventId) -> Result<SessionSnapshot, BackendError> {
        let newSessionId = newSessionId
        return run { records, now in
            try startSessionCommand(records, id: id, now: now, newSessionId: newSessionId())
        }
    }

    public func operateSession(id: SessionEventId, kind: SessionOperationKind) -> Result<SessionSnapshot, BackendError> {
        run { records, now in try operateSessionCommand(records, id: id, kind: kind, now: now) }
    }

    public func writeJournalEntry(id: JournalEntryId, body: String, tags: [TagName]) -> Result<JournalEntry, BackendError> {
        run { records, now in try writeJournalEntryCommand(records, id: id, body: body, tags: tags, now: now) }
    }

    public func editJournalEntry(id: JournalEntryId, body: String, tags: [TagName]) -> Result<JournalEntry, BackendError> {
        run { records, now in try editJournalEntryCommand(records, id: id, body: body, tags: tags, now: now) }
    }

    public func deleteJournalEntry(id: JournalEntryId) -> Result<DeletedJournalEntry, BackendError> {
        run { records, now in try deleteJournalEntryCommand(records, id: id, now: now) }
    }

    public func getTimeline(before: Instant?) -> Result<TimelinePage, BackendError> {
        read { records, now in try NanaichiWorkflows.getTimeline(records, before: before, now: now) }
    }

    public func getTags() -> Result<TagList, BackendError> {
        read { records, _ in try NanaichiWorkflows.getTags(records) }
    }

    public func getTagUsage() -> Result<TagUsageList, BackendError> {
        read { records, _ in try NanaichiWorkflows.getTagUsage(records) }
    }

    public func deleteTag(name: TagName, deletion: TagDeletion) -> Result<DeletedTag, BackendError> {
        run { records, _ in try deleteTagCommand(records, name: name, deletion: deletion) }
    }

    public func getStats(period: StatsPeriod, timeZone: TimeZoneName) -> Result<StatsReport, BackendError> {
        read { records, now in try NanaichiWorkflows.getStats(records, period: period, timeZone: timeZone, now: now) }
    }

    public func getJournalCalendar(month: JournalMonth, timeZone: TimeZoneName) -> Result<JournalCalendar, BackendError> {
        read { records, now in
            try NanaichiWorkflows.getJournalCalendar(records, month: month, timeZone: timeZone, now: now)
        }
    }

    public func getEntriesOnDate(date: LocalDate, timeZone: TimeZoneName) -> Result<EntriesOnDate, BackendError> {
        read { records, _ in try NanaichiWorkflows.getEntriesOnDate(records, date: date, timeZone: timeZone) }
    }

    public func getEntriesWithTag(tag: TagName, before: Instant?) -> Result<TaggedEntriesPage, BackendError> {
        read { records, _ in try NanaichiWorkflows.getEntriesWithTag(records, tag: tag, before: before) }
    }

    public func getAdvanceMode() -> Result<AdvanceMode, BackendError> {
        read { records, now in try NanaichiWorkflows.getAdvanceMode(records, now: now) }
    }

    public func changeAdvanceMode(_ mode: AdvanceMode) -> Result<AdvanceMode, BackendError> {
        run { records, now in
            Result<Executed<AdvanceMode>, Never>.success(try changeAdvanceModeCommand(records, to: mode, now: now))
        }
    }

    // MARK: - 同期メッセージ

    /// 受け取り始めた時点で繋がっている（同じアプリの中なので、繋ぎ直しはない）
    public func subscribe() -> AsyncStream<SyncEvent> {
        let (stream, continuation) = AsyncStream<SyncEvent>.makeStream()
        let id = UUID()
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { await self?.unsubscribe(id) }
        }
        continuation.yield(.connected)
        return stream
    }

    public func checkSyncConnection() {}

    /// 記録に使う時刻はこの端末の時計なので、ずれはない。端末の時計が戻っていても、
    /// `ClockOffset.serverNow` がスナップショットの時刻より前に戻さない
    public func clockOffset() -> ClockOffset { ClockOffset(serverAheadMs: 0) }

    private func unsubscribe(_ id: UUID) {
        subscribers[id] = nil
    }

    private func deliver(_ messages: [SyncMessage]) {
        for message in messages {
            for continuation in subscribers.values {
                continuation.yield(.message(message))
            }
        }
    }
}
