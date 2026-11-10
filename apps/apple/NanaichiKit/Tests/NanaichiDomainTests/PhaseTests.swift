import Testing

@testable import NanaichiDomain

private struct Between: Decodable {
    let previous: TimerState
    let current: TimerState
}

private struct OfState: Decodable { let state: TimerState }

private struct OfProgress: Decodable { let progress: RoundProgress }

@Test("phaseChangeBetween", arguments: Golden.cases("phaseChangeBetween"))
func phaseChangeBetweenCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Between.self) { phaseChangeBetween($0.previous, $0.current) }
}

@Test("remainingRatioOf", arguments: Golden.cases("remainingRatioOf"))
func remainingRatioOfCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, OfState.self) { remainingRatioOf(try #require(InPhase($0.state))) }
}

@Test("upcomingPhaseOf", arguments: Golden.cases("upcomingPhaseOf"))
func upcomingPhaseOfCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, OfState.self) { upcomingPhaseOf(try #require(InPhase($0.state))) }
}

@Test("roundProgressOf", arguments: Golden.cases("roundProgressOf"))
func roundProgressOfCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, OfState.self) {
        roundProgressOf(try #require(UnendedTimerState($0.state)))
    }
}

@Test("setsUntilBreakOf", arguments: Golden.cases("setsUntilBreakOf"))
func setsUntilBreakOfCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, OfProgress.self) { setsUntilBreakOf($0.progress) }
}
