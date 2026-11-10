import Testing

@testable import NanaichiDomain

/// 期間のフィールドと同じオブジェクトに `entries` を並べた入力（TS の `{ ...period, entries }`）
private struct Report: Decodable {
    let period: JournalPeriod
    let entries: [JournalEntry]

    init(from decoder: any Decoder) throws {
        period = try JournalPeriod(from: decoder)
        entries = try decoder.container(keyedBy: Key.self).decode([JournalEntry].self, forKey: .entries)
    }

    private enum Key: CodingKey { case entries }
}

@Test("JournalPeriod.rangeOf", arguments: Golden.cases("JournalPeriod.rangeOf"))
func rangeOfCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, JournalPeriod.self) { $0.range }
}

@Test("JournalPeriod.report", arguments: Golden.cases("JournalPeriod.report"))
func periodReportCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Report.self) { $0.period.report($0.entries) }
}

@Test("JournalPeriod.toJson", arguments: Golden.cases("JournalPeriod.toJson"))
func periodToJsonCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, JournalPeriodReport.self) { $0.json }
}
