import Testing

@testable import NanaichiDomain

private struct Of: Decodable {
    let month: JournalMonth
    let writtenAts: [Instant]
    let now: Instant
    let timeZone: TimeZoneName
}

private struct EntriesOn: Decodable {
    let date: LocalDate
    let entries: [JournalEntry]
    let timeZone: TimeZoneName
}

@Test("JournalCalendar.of", arguments: Golden.cases("JournalCalendar.of"))
func calendarOfCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Of.self) {
        JournalCalendar.of(month: $0.month, writtenAts: $0.writtenAts, now: $0.now, timeZone: $0.timeZone)
    }
}

@Test("JournalCalendar.entriesOn", arguments: Golden.cases("JournalCalendar.entriesOn"))
func entriesOnCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, EntriesOn.self) {
        JournalCalendar.entriesOn($0.date, entries: $0.entries, timeZone: $0.timeZone)
    }
}

@Test("JournalCalendar.windowOfMonth", arguments: Golden.cases("JournalCalendar.windowOfMonth"))
func windowOfMonthCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, JournalMonth.self) { JournalCalendar.window(of: $0) }
}

@Test("JournalCalendar.windowOfDate", arguments: Golden.cases("JournalCalendar.windowOfDate"))
func windowOfDateCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, LocalDate.self) { JournalCalendar.window(of: $0) }
}

@Test("JournalCalendar.monthBefore", arguments: Golden.cases("JournalCalendar.monthBefore"))
func monthBeforeCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, JournalMonth.self) { $0.before }
}

@Test("JournalCalendar.monthAfter", arguments: Golden.cases("JournalCalendar.monthAfter"))
func monthAfterCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, JournalMonth.self) { $0.after }
}

@Test("JournalCalendar.keyOfMonth", arguments: Golden.cases("JournalCalendar.keyOfMonth"))
func keyOfMonthCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, JournalMonth.self) { $0.key }
}
