import NanaichiDomain

public enum EditJournalEntryError: Error, Hashable, Sendable {
    case invalidInput(ValidationError)
    case tagLimitExceeded(TagLimitExceeded)
    case journalEntryNotFound(JournalEntryNotFound)
}

/// 削除していない記入を探す
private func findWritten(_ store: some JournalEntryStore, _ id: JournalEntryId) throws
    -> Result<JournalEntry, EditJournalEntryError>
{
    switch try store.findJournalEntry(id) {
    case .written(let entry): .success(entry)
    case .deleted, nil: .failure(.journalEntryNotFound(JournalEntryNotFound(id: id)))
    }
}

/// ジャーナル記入の本文とタグを書き直す。
///
/// 入力の検証 → 削除していない記入の読み込み → 使っているタグの種類が上限を超えないかの確認
/// → 書き直す → 記録。新しく書くのではないので、セッションが終わったあとでもできる（ADR 0010）。
/// 書いた時刻と紐付きは変えない
public func editJournalEntry(
    _ store: some JournalEntryStore, id: JournalEntryId, body: String, tags: [TagName], now: Instant
) throws -> Result<JournalEntry, EditJournalEntryError> {
    try parseBody(body).mapError(EditJournalEntryError.invalidInput)
        .andThen { body in
            try parseTags(tags).mapError(EditJournalEntryError.invalidInput)
                .andThen { tags in
                    try findWritten(store, id).andThen { entry in
                        try Tag.ensureWithinLimit(inUse: store.listTagsOfOtherEntries(id), tags: tags)
                            .mapError(EditJournalEntryError.tagLimitExceeded)
                            .map { entry.edit(body: body, tags: $0, now: now) }
                    }
                }
        }
        .andThrough(store.saveEditedJournalEntry)
}
