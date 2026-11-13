import Testing

@testable import NanaichiDomain

private struct Derivation: Decodable {
    let events: SessionEvents
    let now: Instant
    let journalEntryTimes: [Instant]
    let advanceModeChanges: [AdvanceModeChange]
}

private struct AutoEnd: Decodable {
    let events: SessionEvents
    let journalEntryTimes: [Instant]
    let advanceModeChanges: [AdvanceModeChange]
}

@Test("deriveTimerState", arguments: Golden.cases("deriveTimerState"))
func deriveTimerStateCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Derivation.self) {
        GoldenResult(
            deriveTimerState(
                $0.events, now: $0.now, journalEntryTimes: $0.journalEntryTimes,
                advanceModeChanges: $0.advanceModeChanges))
    }
}

@Test("deriveSetOutcomes", arguments: Golden.cases("deriveSetOutcomes"))
func deriveSetOutcomesCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Derivation.self) {
        GoldenResult(
            deriveSetOutcomes(
                $0.events, now: $0.now, journalEntryTimes: $0.journalEntryTimes,
                advanceModeChanges: $0.advanceModeChanges))
    }
}

@Test("autoEndDueAt", arguments: Golden.cases("autoEndDueAt"))
func autoEndDueAtCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, AutoEnd.self) {
        autoEndDueAt(
            $0.events, journalEntryTimes: $0.journalEntryTimes, advanceModeChanges: $0.advanceModeChanges)
    }
}
