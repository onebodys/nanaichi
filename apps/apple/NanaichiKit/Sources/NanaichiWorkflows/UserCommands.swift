import NanaichiDomain

/// 書き込みの結果と、その書き込みのあとで他の画面へ知らせる同期メッセージ。
/// どの書き込みで何を知らせるかは、この1か所で決める（TS の `workflows/user-commands.ts`、ADR 0012・0019）
public struct Executed<Value> {
    public let value: Value
    public let messages: [SyncMessage]

    public init(value: Value, messages: [SyncMessage]) {
        self.value = value
        self.messages = messages
    }

    /// 何も書かない読み込み。知らせることはない
    public static func read(_ value: Value) -> Executed { Executed(value: value, messages: []) }
}

extension Executed: Sendable where Value: Sendable {}

public func startSessionCommand(
    _ store: some StartSessionStore, id: SessionEventId, now: Instant, newSessionId: SessionId
) throws -> Result<Executed<SessionSnapshot>, StartSessionError> {
    try startSession(store, id: id, now: now, newSessionId: newSessionId)
        .map { Executed(value: $0, messages: [.sessionChanged($0)]) }
}

public func operateSessionCommand(
    _ store: some SessionStore, id: SessionEventId, kind: SessionOperationKind, now: Instant
) throws -> Result<Executed<SessionSnapshot>, OperateSessionError> {
    try operateSession(store, id: id, kind: kind, now: now)
        .map { Executed(value: $0, messages: [.sessionChanged($0)]) }
}

/// 記入で自動終了の時刻が延びるので、書いたあとのスナップショットもあわせて知らせる（ADR 0012）
public func writeJournalEntryCommand(
    _ store: some WriteJournalEntryStore, id: JournalEntryId, body: String, tags: [TagName], now: Instant
) throws -> Result<Executed<JournalEntry>, WriteJournalEntryError> {
    try writeJournalEntry(store, id: id, body: body, tags: tags, now: now)
        .tryMap { entry in
            Executed(
                value: entry,
                messages: [.journalEntrySaved(entry), .sessionChanged(try getCurrentSession(store, now: now))])
        }
}

public func editJournalEntryCommand(
    _ store: some JournalEntryStore, id: JournalEntryId, body: String, tags: [TagName], now: Instant
) throws -> Result<Executed<JournalEntry>, EditJournalEntryError> {
    try editJournalEntry(store, id: id, body: body, tags: tags, now: now)
        .map { Executed(value: $0, messages: [.journalEntrySaved($0)]) }
}

public func deleteJournalEntryCommand(_ store: some JournalEntryStore, id: JournalEntryId, now: Instant) throws
    -> Result<Executed<DeletedJournalEntry>, DeleteJournalEntryError>
{
    try deleteJournalEntry(store, id: id, now: now)
        .map { Executed(value: $0, messages: [.journalEntryDeleted($0)]) }
}

/// 書き換えた記入は知らせない。削除したタグと付け替え先を送り、画面が同じ削除を当てる（ADR 0017）
public func deleteTagCommand(_ store: some DeleteTagStore, name: TagName, deletion: TagDeletion) throws
    -> Result<Executed<DeletedTag>, DeleteTagRejected>
{
    try deleteTag(store, name: name, deletion: deletion)
        .map { Executed(value: $0, messages: [.tagDeleted($0)]) }
}

private func advanceModeMessages(_ changed: AdvanceModeChangeResult) -> [SyncMessage] {
    switch changed {
    case .unchanged:
        return []
    case .changed(let mode, let snapshot):
        switch snapshot {
        case .session: return [.advanceModeChanged(mode), .sessionChanged(snapshot)]
        case .noSession: return [.advanceModeChanged(mode)]
        }
    }
}

public func changeAdvanceModeCommand(_ store: some ChangeAdvanceModeStore, to mode: AdvanceMode, now: Instant)
    throws -> Executed<AdvanceMode>
{
    let changed = try changeAdvanceMode(store, to: mode, now: now)
    return Executed(value: changed.mode, messages: advanceModeMessages(changed))
}
