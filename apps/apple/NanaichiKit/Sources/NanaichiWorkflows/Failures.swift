import NanaichiDomain

/// 入力が不正（TS の `ValidationError`）。`field` はどの入力かで、入力された値は持たない（本文は PII）
public struct ValidationError: Error, Hashable, Sendable {
    public let field: String
}

/// 記入が記録されていないか、削除されている（ADR 0010）
public struct JournalEntryNotFound: Error, Hashable, Sendable {
    public let id: JournalEntryId
}

/// 記録済みの操作イベントと同じ ID で、別の操作が届いた（クライアントの ID の発行の誤り）
public struct EventIdConflict: Error, Hashable, Sendable {
    public let eventId: SessionEventId
}

/// 記入の本文を検証する。前後の空白を落として空か長すぎれば書けない
func parseBody(_ body: String) -> Result<JournalEntryBody, ValidationError> {
    JournalEntryBody(body).map(Result.success) ?? .failure(ValidationError(field: "body"))
}

/// 記入につけるタグを検証する。同じ名前は1つにまとめ、上限の種類より多くはつけられない
func parseTags(_ tags: [TagName]) -> Result<[TagName], ValidationError> {
    Tags.of(tags).map(Result.success) ?? .failure(ValidationError(field: "tags"))
}
