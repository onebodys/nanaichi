import NanaichiDomain

public typealias StartSessionStore = SessionStore & AdvanceModeStore

public enum StartSessionError: Error, Hashable, Sendable {
    /// 同時に持てるセッションは1つまで
    case sessionAlreadyInProgress(SessionId)
    case eventIdConflict(EventIdConflict)
}

private func ensureNoSessionInProgress(_ open: Session?) -> Result<Void, StartSessionError> {
    open.map { .failure(.sessionAlreadyInProgress($0.id)) } ?? .success(())
}

/// セッションを開始する（GLOSSARY の「開始」）。
///
/// 同じ開始が記録済みなら再送として扱う → 現在のセッションがないことの確認
/// → 開始（そのときのフェーズの進め方で計算する） → 記録。自動終了の時刻を過ぎたセッションは、確認の前に閉じる（`loadOpenSession`）。
///
/// 時刻と新しいセッションの ID は呼び出し側が渡す（ドメインとワークフローは時計と乱数を読まない）
public func startSession(
    _ store: some StartSessionStore, id: SessionEventId, now: Instant, newSessionId: SessionId
) throws -> Result<SessionSnapshot, StartSessionError> {
    if let recorded = try store.findSessionByEventId(id) {
        return replayRecordedEvent(recorded, eventId: id, requested: .start, now: now)
            .mapError(StartSessionError.eventIdConflict)
    }
    return try ensureNoSessionInProgress(loadOpenSession(store, now: now))
        .tryMap {
            Session.start(
                id: newSessionId, startEventId: id, now: now,
                advanceModeChanges: try store.loadAdvanceModeChanges())
        }
        .andThrough(store.saveStartedSession)
        .map { $0.snapshot(at: now) }
}
