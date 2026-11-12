import Foundation
import NanaichiDomain

/// アカウントの記録先（UserDO）で動く `Backend` と `TaskBackend`（TS の `createRemoteBackend` と `createTaskApi`）。
///
/// ログインしているあいだ、アプリの中で1つだけ作り、画面で共有する。HTTP の API に `Authorization: Bearer` を付けて送り、
/// 応答はドメインの型で検証する。ログインが切れていたら（`UNAUTHENTICATED`）、失敗を返す前に `onSignedOut` を呼ぶ。
/// アプリはそこでトークンを消し、この端末の記録先に戻す。
///
/// ログアウトするときは、アプリが `close()` を呼んで同期の接続をすべて閉じる（`onSignedOut` の中でもよい）。
/// 同時に複数の 401 が返ると `onSignedOut` は2回以上呼ばれうるので、アプリの側は何回呼ばれても同じ結果になるようにする
public actor AccountBackend: Backend, TaskBackend {
    private let api: ApiClient
    private let clock: @Sendable () -> Instant
    private let openSocket: OpenSyncSocket
    private let scheduler: any SyncScheduler
    private var offset = ClockOffset(serverAheadMs: 0)
    private var connections: [UUID: SyncConnection] = [:]
    private var isClosed = false

    /// - Parameters:
    ///   - server: 開発では `http://localhost:…` などに替える
    ///   - session: テストでは `URLProtocol` を差し替えたものを渡す
    ///   - openSocket: 同期の WebSocket の開き方。nil なら `server` の `/api/ws` に Bearer で繋ぐ
    public init(
        token: SessionToken,
        server: URL = AccountServer.production,
        session: URLSession = .shared,
        clock: @escaping @Sendable () -> Instant = AccountBackend.systemClock,
        openSocket: OpenSyncSocket? = nil,
        scheduler: any SyncScheduler = SleepingSyncScheduler(),
        onSignedOut: @escaping @Sendable () -> Void
    ) {
        api = ApiClient(server: server, session: session, token: token, onSignedOut: onSignedOut)
        self.clock = clock
        self.openSocket = openSocket ?? WebSocketSyncSocket.opener(server: server, token: token)
        self.scheduler = scheduler
    }

    public static let systemClock: @Sendable () -> Instant = {
        Instant(milliseconds: Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)))
    }

    /// スナップショットを取りに行き、送ってから受け取るまでの端末の時刻で時計のずれを測る
    private func snapshot(_ request: ApiRequest) async -> Result<SessionSnapshot, BackendError> {
        let requestedAt = clock()
        let result = await api.call(request, as: SessionSnapshot.self)
        let receivedAt = clock()
        if case .success(let snapshot) = result {
            offset = ClockOffset.measure(
                .init(requestedAt: requestedAt, receivedAt: receivedAt, serverTime: snapshot.serverTime))
        }
        return result
    }

    // MARK: - Backend

    public func getCurrentSession() async -> Result<SessionSnapshot, BackendError> {
        await snapshot(.get("session", "current"))
    }

    public func startSession(id: SessionEventId) async -> Result<SessionSnapshot, BackendError> {
        await snapshot(.send(.post, "session", json: StartBody(id: id)))
    }

    public func operateSession(id: SessionEventId, kind: SessionOperationKind) async
        -> Result<SessionSnapshot, BackendError>
    {
        await snapshot(.send(.post, "session", "commands", json: OperateBody(id: id, kind: kind)))
    }

    public func writeJournalEntry(id: JournalEntryId, body: String, tags: [TagName]) async
        -> Result<JournalEntry, BackendError>
    {
        await api.call(.send(.post, "journal-entries", json: WriteEntryBody(id: id, body: body, tags: tags)))
    }

    public func editJournalEntry(id: JournalEntryId, body: String, tags: [TagName]) async
        -> Result<JournalEntry, BackendError>
    {
        await api.call(.send(.patch, "journal-entries", id.rawValue, json: EditEntryBody(body: body, tags: tags)))
    }

    public func deleteJournalEntry(id: JournalEntryId) async -> Result<DeletedJournalEntry, BackendError> {
        await api.call(.send(.delete, "journal-entries", id.rawValue))
    }

    public func getTimeline(before: Instant?) async -> Result<TimelinePage, BackendError> {
        await api.call(.get("timeline", query: before.map { [("before", $0.iso8601)] } ?? []))
    }

    public func getTags() async -> Result<TagList, BackendError> {
        await api.call(.get("tags"))
    }

    public func getTagUsage() async -> Result<TagUsageList, BackendError> {
        await api.call(.get("tags", "usage"))
    }

    public func deleteTag(name: TagName, deletion: TagDeletion) async -> Result<DeletedTag, BackendError> {
        await api.call(.send(.delete, "tags", name.rawValue, json: deletion))
    }

    public func getStats(period: StatsPeriod, timeZone: TimeZoneName) async -> Result<StatsReport, BackendError> {
        await api.call(.get("stats", query: [("period", period.rawValue), ("timeZone", timeZone.identifier)]))
    }

    public func getJournalCalendar(month: JournalMonth, timeZone: TimeZoneName) async
        -> Result<JournalCalendar, BackendError>
    {
        await api.call(.get("journal-calendar", query: [("month", month.key), ("timeZone", timeZone.identifier)]))
    }

    public func getEntriesOnDate(date: LocalDate, timeZone: TimeZoneName) async
        -> Result<EntriesOnDate, BackendError>
    {
        await api.call(
            .get("journal-entries", "by-date", query: [("date", date.key), ("timeZone", timeZone.identifier)]))
    }

    public func getEntriesWithTag(tag: TagName, before: Instant?) async -> Result<TaggedEntriesPage, BackendError> {
        await api.call(
            .get("journal-entries", "by-tag", query: [("tag", tag.rawValue)] + (before.map { [("before", $0.iso8601)] } ?? [])))
    }

    public func getAdvanceMode() async -> Result<AdvanceMode, BackendError> {
        await api.call(.get("settings", "advance-mode"))
    }

    public func changeAdvanceMode(_ mode: AdvanceMode) async -> Result<AdvanceMode, BackendError> {
        await api.call(.send(.put, "settings", "advance-mode", json: mode))
    }

    public func clockOffset() -> ClockOffset { offset }

    // MARK: - 同期メッセージ

    /// 受け取り始めるたびに、WebSocket の接続を1本張る（Web のタブごとの接続と同じ）
    public func subscribe() async -> AsyncStream<SyncEvent> {
        let (stream, continuation) = AsyncStream<SyncEvent>.makeStream()
        guard !isClosed else {
            continuation.finish()
            return stream
        }
        let connection = SyncConnection(openSocket: openSocket, scheduler: scheduler, deliver: continuation)
        let id = UUID()
        connections[id] = connection
        continuation.onTermination = { [weak self] _ in
            Task {
                await connection.close()
                await self?.forget(id)
            }
        }
        await connection.start()
        return stream
    }

    public func checkSyncConnection() async {
        for connection in connections.values {
            await connection.check()
        }
    }

    /// 同期の接続をすべて閉じ、受け取りのストリームを終える（`for await` が抜ける）。繋ぎ直しも止まる。
    /// 閉じたあとの `subscribe()` は、すぐ終わるストリームを返す。ログアウトで呼ぶ
    public func close() async {
        isClosed = true
        let closing = connections.values
        connections = [:]
        for connection in closing {
            await connection.close()
        }
    }

    private func forget(_ id: UUID) {
        connections[id] = nil
    }

    // MARK: - TaskBackend

    public func getTaskSetting() async -> Result<TaskSetting, BackendError> {
        await api.call(.get("settings", "tasks"))
    }

    public func changeTaskSetting(_ setting: TaskSetting) async -> Result<TaskSetting, BackendError> {
        await api.call(.send(.put, "settings", "tasks", json: setting))
    }

    public func getTasks() async -> Result<TaskList, BackendError> {
        await api.call(.get("tasks"))
    }

    public func createTask(id: TaskId, title: TaskTitle) async -> Result<TodoTask, BackendError> {
        await api.call(.send(.post, "tasks", json: CreateTaskBody(id: id, title: title)))
    }

    public func renameTask(id: TaskId, title: TaskTitle) async -> Result<TodoTask, BackendError> {
        await api.call(.send(.patch, "tasks", id.rawValue, json: RenameTaskBody(title: title)))
    }

    public func completeTask(id: TaskId) async -> Result<TodoTask, BackendError> {
        await api.call(.send(.post, "tasks", id.rawValue, "complete"))
    }

    public func reopenTask(id: TaskId) async -> Result<TodoTask, BackendError> {
        await api.call(.send(.post, "tasks", id.rawValue, "reopen"))
    }

    public func deleteTask(id: TaskId) async -> Result<DeletedTask, BackendError> {
        await api.call(.send(.delete, "tasks", id.rawValue))
    }
}

// リクエストの本文。フィールドの名前は Web の API のまま

private struct StartBody: Encodable {
    let id: SessionEventId
}

private struct OperateBody: Encodable {
    let id: SessionEventId
    let kind: SessionOperationKind
}

private struct WriteEntryBody: Encodable {
    let id: JournalEntryId
    let body: String
    let tags: [TagName]
}

private struct EditEntryBody: Encodable {
    let body: String
    let tags: [TagName]
}

private struct CreateTaskBody: Encodable {
    let id: TaskId
    let title: TaskTitle
}

private struct RenameTaskBody: Encodable {
    let title: TaskTitle
}
