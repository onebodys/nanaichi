import Testing

@testable import NanaichiDomain

private struct Of: Decodable {
    let records: StatsRecords
    let period: StatsPeriod
    let now: Instant
    let timeZone: TimeZoneName
}

private struct Report: Decodable { let report: StatsReport }

@Test("Stats.of", arguments: Golden.cases("Stats.of"))
func statsOfCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Of.self) {
        Stats.of(records: $0.records, period: $0.period, now: $0.now, timeZone: $0.timeZone)
    }
}

@Test("Stats.completedSetsOf", arguments: Golden.cases("Stats.completedSetsOf"))
func completedSetsOfCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Report.self) { $0.report.completedSets }
}

@Test("CompactStats.of", arguments: Golden.cases("CompactStats.of"))
func compactOfCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Report.self) { CompactStats.of($0.report) }
}

@Test("CompactStats.withCalendarOf", arguments: Golden.cases("CompactStats.withCalendarOf"))
func compactWithCalendarCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Report.self) { CompactStats.withCalendarOf($0.report) }
}
