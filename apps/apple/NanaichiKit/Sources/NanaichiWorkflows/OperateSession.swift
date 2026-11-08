import NanaichiDomain

public enum OperateSessionError: Error, Hashable, Sendable {
    /// セッションの外では操作できない
    case noSessionInProgress
    case operationRejected(OperationRejected)
    case eventIdConflict(EventIdConflict)
}

private func ensureSessionInProgress(_ open: Session?) -> Result<Session, OperateSessionError> {
    open.map(Result.success) ?? .failure(.noSessionInProgress)
}

/// 受け付けた操作を記録する。終了したなら、セッションを閉じて現在のセッションでなくする
private func record(
    _ store: some SessionStore, _ operation: RecordedSessionEvent<SessionOperation>
) -> (OperatedSession) throws -> Void {
    { operated in
        try store.appendSessionOperation(operated.session.id, operation)
        switch operated.state {
        case .ended(let ended): try store.closeSession(operated.session.id, ended)
        case .idle, .focus, .journal, .breakTime, .awaitingAdvance: break
        }
    }
}

/// セッションに操作を加える（一時停止・再開・中断・集中の再開始・休憩スキップ・進める・終了）。
///
/// 同じ操作が記録済みなら再送として扱う → 現在のセッションの読み込み
/// → その状態でできる操作かの判断 → 記録。時刻は呼び出し側が渡す
public func operateSession(
    _ store: some SessionStore, id: SessionEventId, kind: SessionOperationKind, now: Instant
) throws -> Result<SessionSnapshot, OperateSessionError> {
    if let recorded = try store.findSessionByEventId(id) {
        return replayRecordedEvent(recorded, eventId: id, requested: .operation(kind), now: now)
            .mapError(OperateSessionError.eventIdConflict)
    }
    let operation = RecordedSessionEvent(id: id, event: SessionOperation(kind: kind, at: now))
    return try ensureSessionInProgress(loadOpenSession(store, now: now))
        .flatMap { $0.operate(operation).mapError(OperateSessionError.operationRejected) }
        .andThrough(record(store, operation))
        .map { $0.session.snapshot(at: now) }
}
