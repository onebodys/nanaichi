/// API が想定内の失敗のときに返すエラーの種類（TS の `API_ERROR_CODES`）。サーバーは応答の本文の `error` に
/// これを入れ、クライアントは本文を検証してから、種類ごとに画面での扱いを決める（AGENTS.md §5）
public enum ApiErrorCode: String, CaseIterable, Codable, Sendable {
    /// ログインしていない（401）
    case unauthenticated = "UNAUTHENTICATED"
    /// 許可リストに載っていない（403）
    case emailNotAllowed = "EMAIL_NOT_ALLOWED"
    /// リクエストの本文やクエリが不正（400）
    case invalidRequest = "INVALID_REQUEST"
    /// 同時に持てるセッションは1つまで（409）
    case sessionAlreadyInProgress = "SESSION_ALREADY_IN_PROGRESS"
    /// セッションの外での操作やジャーナル記入（409）
    case noSessionInProgress = "NO_SESSION_IN_PROGRESS"
    /// その状態ではできない操作（409）
    case operationRejected = "OPERATION_REJECTED"
    /// 記録済みの操作イベントと同じ ID で別の操作（409、ADR 0007）
    case eventIdConflict = "EVENT_ID_CONFLICT"
    /// 使えるタグの種類の上限を超える（409、ADR 0013）
    case tagLimitExceeded = "TAG_LIMIT_EXCEEDED"
    /// ジャーナル記入が記録されていないか、削除されている（404、ADR 0010）
    case journalEntryNotFound = "JOURNAL_ENTRY_NOT_FOUND"
    /// 削除するタグか付け替え先のタグが、どの記入にもついていない（404、ADR 0017）
    case tagNotFound = "TAG_NOT_FOUND"
    /// タスクが記録されていない（404、ADR 0026）
    case taskNotFound = "TASK_NOT_FOUND"
    /// `GET /api/ws` に WebSocket の Upgrade がない（426、ADR 0012）
    case websocketUpgradeRequired = "WEBSOCKET_UPGRADE_REQUIRED"
    /// `GET /api/ws` の Origin がこのアプリと違う（403、ADR 0012）
    case crossOriginRejected = "CROSS_ORIGIN_REJECTED"
    /// 同じユーザーからのリクエストが短い時間に多すぎる（429、ADR 0018）
    case rateLimited = "RATE_LIMITED"
    /// ネイティブアプリのログインのコードが使えない。知らない・使用済み・期限切れ・code_verifier の違い（400、ADR 0029）。
    /// 同じコードで引き換え直さず、新しい code_verifier でログインし直す
    case invalidGrant = "INVALID_GRANT"
}

/// エラーの応答の本文。`error` のほかに、種類ごとの補足（`paths` や `operation`）が付くことがある。
/// 補足は今のところ画面で使わないので、`error` だけを読み、ほかのフィールドは読み飛ばす
public struct ApiErrorBody: Hashable, Sendable, Codable {
    public let error: ApiErrorCode
}
