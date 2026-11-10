import Testing

@testable import NanaichiDomain

private struct Page: Decodable {
    let tag: TagName
    let found: [JournalEntry]
    let limit: Int
}

private struct Merge: Decodable {
    let loaded: [JournalEntry]
    let more: [JournalEntry]
}

private struct ByDate: Decodable {
    let entries: [JournalEntry]
    let timeZone: TimeZoneName
}

@Test("TaggedEntries.page", arguments: Golden.cases("TaggedEntries.page"))
func taggedPageCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Page.self) { TaggedEntries.page(tag: $0.tag, found: $0.found, limit: $0.limit) }
}

@Test("TaggedEntries.merge", arguments: Golden.cases("TaggedEntries.merge"))
func taggedMergeCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Merge.self) { TaggedEntries.merge($0.loaded, $0.more) }
}

@Test("TaggedEntries.byDate", arguments: Golden.cases("TaggedEntries.byDate"))
func byDateCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, ByDate.self) { TaggedEntries.byDate($0.entries, timeZone: $0.timeZone) }
}
