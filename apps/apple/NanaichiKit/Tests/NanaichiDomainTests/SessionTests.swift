import Testing

@testable import NanaichiDomain

private struct Summary: Decodable {
    let session: Session
    let ended: TimerState
    let now: Instant
    let entries: EntryCount
}

private struct Start: Decodable {
    let id: SessionId
    let startEventId: SessionEventId
    let now: Instant
    let advanceModeChanges: [AdvanceModeChange]
}

private struct At: Decodable {
    let session: Session
    let now: Instant
}

private struct Operate: Decodable {
    let session: Session
    let operation: RecordedSessionEvent<SessionOperation>
}

private struct Only: Decodable { let session: Session }

private struct NotEnded: Error { let state: TimerState }

private struct Snapshots: Decodable {
    let received: SessionSnapshot
    let current: SessionSnapshot
}

@Test("SessionSummary.of", arguments: Golden.cases("SessionSummary.of"))
func summaryCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Summary.self) { input in
        guard case .ended(let ended) = input.ended else { throw NotEnded(state: input.ended) }
        return SessionSummary.of(session: input.session, ended: ended, now: input.now, entries: input.entries)
    }
}

@Test("Session.start", arguments: Golden.cases("Session.start"))
func startCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Start.self) {
        Session.start(
            id: $0.id, startEventId: $0.startEventId, now: $0.now,
            advanceModeChanges: $0.advanceModeChanges)
    }
}

@Test("Session.stateAt", arguments: Golden.cases("Session.stateAt"))
func stateAtCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, At.self) { $0.session.stateAt($0.now) }
}

@Test("Session.operate", arguments: Golden.cases("Session.operate"))
func operateCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Operate.self) { GoldenResult($0.session.operate($0.operation)) }
}

@Test("Session.autoEndDueAt", arguments: Golden.cases("Session.autoEndDueAt"))
func sessionAutoEndDueAtCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Only.self) { $0.session.autoEndDueAt }
}

@Test("Session.availableOperations", arguments: Golden.cases("Session.availableOperations"))
func availableOperationsCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, At.self) { $0.session.availableOperations(at: $0.now) }
}

@Test("SessionSnapshot.isOlder", arguments: Golden.cases("SessionSnapshot.isOlder"))
func isOlderCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Snapshots.self) { $0.received.isOlder(than: $0.current) }
}
