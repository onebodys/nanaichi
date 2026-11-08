import Testing

@testable import NanaichiDomain

private struct ModeAt: Decodable {
    let changes: [AdvanceModeChange]
    let time: Instant
}

private struct IsManual: Decodable {
    let mode: AdvanceMode
    let from: PhaseKind
    let to: PhaseKind
}

private struct RelevantSince: Decodable {
    let changes: [AdvanceModeChange]
    let startedAt: Instant
}

@Test("AdvanceModeChange.modeAt", arguments: Golden.cases("AdvanceModeChange.modeAt"))
func modeAtCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, ModeAt.self) { AdvanceModeChange.modeAt($0.changes, $0.time) }
}

@Test("AdvanceMode.isManual", arguments: Golden.cases("AdvanceMode.isManual"))
func isManualCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, IsManual.self) { $0.mode.isManual(from: $0.from, to: $0.to) }
}

@Test("AdvanceModeChange.relevantSince", arguments: Golden.cases("AdvanceModeChange.relevantSince"))
func relevantSinceCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, RelevantSince.self) {
        AdvanceModeChange.relevantSince($0.changes, $0.startedAt)
    }
}
