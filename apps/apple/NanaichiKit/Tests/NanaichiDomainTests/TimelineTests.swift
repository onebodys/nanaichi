import Testing

@testable import NanaichiDomain

private struct Build: Decodable {
    let sessions: [TimelineSession]
    let next: PageCursor
    let now: Instant
    let timeZone: TimeZoneName
}

private struct CompletedSetsOn: Decodable {
    let days: [TimelineDay]
    let now: Instant
    let timeZone: TimeZoneName
}

private struct WithDayCounted: Decodable {
    let days: [TimelineDay]
    let dateKey: String
    let count: Int
}

private struct EntryCountOf: Decodable {
    let days: [TimelineDay]
    let sessionId: SessionId
}

private struct Merge: Decodable {
    let loaded: [TimelineSession]
    let more: [TimelineSession]
}

private struct WithCurrentSession: Decodable {
    let sessions: [TimelineSession]
    let current: Session
}

private struct PutEntry: Decodable {
    let sessions: [TimelineSession]
    let entry: JournalEntry
}

private struct RemoveEntry: Decodable {
    let sessions: [TimelineSession]
    let id: JournalEntryId
}

private struct DeleteTag: Decodable {
    let sessions: [TimelineSession]
    let deleted: DeletedTag
}

private struct Page: Decodable {
    let found: [TimelineSession]
    let limit: Int
    let serverTime: Instant
}

@Test("Timeline.build", arguments: Golden.cases("Timeline.build"))
func buildCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Build.self) {
        Timeline.build(sessions: $0.sessions, next: $0.next, now: $0.now, timeZone: $0.timeZone)
    }
}

@Test("Timeline.completedSetsOn", arguments: Golden.cases("Timeline.completedSetsOn"))
func completedSetsOnCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, CompletedSetsOn.self) {
        Timeline.completedSetsOn($0.days, now: $0.now, timeZone: $0.timeZone)
    }
}

@Test("Timeline.withDayCounted", arguments: Golden.cases("Timeline.withDayCounted"))
func withDayCountedCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, WithDayCounted.self) {
        Timeline.withDayCounted($0.days, date: try parsed(LocalDate(key: $0.dateKey)), count: $0.count)
    }
}

@Test("Timeline.entryCountOf", arguments: Golden.cases("Timeline.entryCountOf"))
func entryCountOfCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, EntryCountOf.self) { Timeline.entryCountOf($0.days, sessionId: $0.sessionId) }
}

@Test("Timeline.merge", arguments: Golden.cases("Timeline.merge"))
func timelineMergeCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Merge.self) { Timeline.merge($0.loaded, $0.more) }
}

@Test("Timeline.withCurrentSession", arguments: Golden.cases("Timeline.withCurrentSession"))
func withCurrentSessionCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, WithCurrentSession.self) {
        Timeline.withCurrentSession($0.sessions, current: $0.current)
    }
}

@Test("Timeline.putEntry", arguments: Golden.cases("Timeline.putEntry"))
func putEntryCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, PutEntry.self) { Timeline.putEntry($0.sessions, $0.entry) }
}

@Test("Timeline.removeEntry", arguments: Golden.cases("Timeline.removeEntry"))
func removeEntryCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, RemoveEntry.self) { Timeline.removeEntry($0.sessions, id: $0.id) }
}

@Test("Timeline.deleteTag", arguments: Golden.cases("Timeline.deleteTag"))
func timelineDeleteTagCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, DeleteTag.self) { Timeline.deleteTag($0.sessions, $0.deleted) }
}

@Test("Timeline.page", arguments: Golden.cases("Timeline.page"))
func timelinePageCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Page.self) {
        Timeline.page(found: $0.found, limit: $0.limit, serverTime: $0.serverTime)
    }
}
