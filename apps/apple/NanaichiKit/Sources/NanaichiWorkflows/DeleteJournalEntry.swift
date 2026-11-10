import NanaichiDomain

public enum DeleteJournalEntryError: Error, Hashable, Sendable {
    case journalEntryNotFound(JournalEntryNotFound)
}

/// ジャーナル記入を削除する（論理削除、ADR 0010）。
///
/// 記入の読み込み → 削除。すでに削除してあれば、通信のやり直しとして記録済みの削除を返す。
/// セッションが終わったあとでもできる。削除した記入はタイムラインに出ないが、自動終了の判断では書いたものとして数える
public func deleteJournalEntry(_ store: some JournalEntryStore, id: JournalEntryId, now: Instant) throws
    -> Result<DeletedJournalEntry, DeleteJournalEntryError>
{
    switch try store.findJournalEntry(id) {
    case nil:
        return .failure(.journalEntryNotFound(JournalEntryNotFound(id: id)))
    case .deleted(let deleted):
        return .success(deleted)
    case .written:
        let deleted = DeletedJournalEntry(id: id, deletedAt: now)
        try store.deleteJournalEntry(deleted)
        return .success(deleted)
    }
}
