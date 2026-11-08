import Testing

@testable import NanaichiDomain

private struct CompletedSets: Decodable { let completedSets: Int }

@Test("FocusTime.ofCompletedSets", arguments: Golden.cases("FocusTime.ofCompletedSets"))
func focusTimeOfCompletedSets(_ golden: GoldenCase) throws {
    try Golden.check(golden, CompletedSets.self) { FocusTime.ofCompletedSets($0.completedSets) }
}
