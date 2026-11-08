import NanaichiDomain

/// 届いた操作イベントの種類。開始かそれ以降の操作か
enum RequestedEvent: Hashable {
    case start
    case operation(SessionOperationKind)
}

private func recordedKind(of eventId: SessionEventId, in session: Session) -> RequestedEvent? {
    if session.events.start.id == eventId { return .start }
    return session.events.operations.first { $0.id == eventId }.map { .operation($0.event.kind) }
}

/// 同じ ID の操作イベントがすでに記録されていれば、記録し直さずに、そのセッションの今の様子を返す。
///
/// 通信のやり直しで同じ操作が2回届いても、1回目と同じ成功として扱う（ADR 0007）。
/// 1回目のあとにセッションが閉じていても、そのセッションの今の様子（終了）を返す
func replayRecordedEvent(
    _ session: Session, eventId: SessionEventId, requested: RequestedEvent, now: Instant
) -> Result<SessionSnapshot, EventIdConflict> {
    recordedKind(of: eventId, in: session) == requested
        ? .success(session.snapshot(at: now)) : .failure(EventIdConflict(eventId: eventId))
}
