import NanaichiDomain

public typealias WriteJournalEntryStore = SessionStore & JournalEntryStore

public enum WriteJournalEntryError: Error, Hashable, Sendable {
    case invalidInput(ValidationError)
    case noSessionInProgress
    case tagLimitExceeded(TagLimitExceeded)
    case journalEntryNotFound(JournalEntryNotFound)
}

private struct ValidInput {
    let id: JournalEntryId
    let body: JournalEntryBody
    let tags: [TagName]
}

private func parseInput(id: JournalEntryId, body: String, tags: [TagName])
    -> Result<ValidInput, WriteJournalEntryError>
{
    parseBody(body).flatMap { body in parseTags(tags).map { ValidInput(id: id, body: body, tags: $0) } }
        .mapError(WriteJournalEntryError.invalidInput)
}

/// 通信のやり直しで同じ記入が2回届いたら、1回目に記録したものを返す。削除した記入と同じ ID では書けない（ADR 0010）
private func replay(_ recorded: StoredJournalEntry) -> Result<JournalEntry, WriteJournalEntryError> {
    switch recorded {
    case .written(let entry): .success(entry)
    case .deleted(let deleted): .failure(.journalEntryNotFound(JournalEntryNotFound(id: deleted.id)))
    }
}

private func ensureSessionInProgress(_ open: Session?) -> Result<Session, WriteJournalEntryError> {
    open.map(Result.success) ?? .failure(.noSessionInProgress)
}

private func write(_ store: some WriteJournalEntryStore, _ input: ValidInput, now: Instant) throws
    -> Result<JournalEntry, WriteJournalEntryError>
{
    try ensureSessionInProgress(loadOpenSession(store, now: now))
        .andThen { session in
            try Tag.ensureWithinLimit(inUse: store.listTagsOfOtherEntries(input.id), kept: [], tags: input.tags)
                .mapError(WriteJournalEntryError.tagLimitExceeded)
                .flatMap { tags in
                    JournalEntry.write(
                        id: input.id, body: input.body, tags: tags, sessionId: session.id,
                        state: session.stateAt(now), now: now
                    ).mapError { _ in .noSessionInProgress }
                }
        }
        .andThrough(store.saveJournalEntry)
}

/// ジャーナル記入を書く（GLOSSARY の「ジャーナル記入」）。
///
/// 入力の検証 → 同じ ID の記入が記録済みなら再送として扱う → 現在のセッションの読み込み
/// → 使っているタグの種類が上限を超えないかの確認 → 書いた時点のタイマーの状態に紐付けて書く → 記録。
/// セッションの外では書けない。自動終了の時刻を過ぎたセッションは、読み込むときに閉じる（`loadOpenSession`）ので書けない
public func writeJournalEntry(
    _ store: some WriteJournalEntryStore, id: JournalEntryId, body: String, tags: [TagName], now: Instant
) throws -> Result<JournalEntry, WriteJournalEntryError> {
    try parseInput(id: id, body: body, tags: tags).andThen { input in
        if let recorded = try store.findJournalEntry(input.id) { return replay(recorded) }
        return try write(store, input, now: now)
    }
}
