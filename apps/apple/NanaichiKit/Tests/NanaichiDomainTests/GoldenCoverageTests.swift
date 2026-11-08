import Testing

/// まだ Swift に移していない関数（#140 で記録と振り返りのドメインを移す）。移したらここから消す
private let notYetPorted: Set<String> = [
    "CompactStats.of",
    "CompactStats.withCalendarOf",
    "DeletedTag.applyTo",
    "DeletedTag.ensureDeletable",
    "JournalCalendar.entriesOn",
    "JournalCalendar.keyOfMonth",
    "JournalCalendar.monthAfter",
    "JournalCalendar.monthBefore",
    "JournalCalendar.of",
    "JournalCalendar.windowOfDate",
    "JournalCalendar.windowOfMonth",
    "JournalEntry.deleteTag",
    "JournalEntry.edit",
    "JournalEntry.write",
    "JournalEntryBody.parse",
    "JournalPeriod.rangeOf",
    "JournalPeriod.report",
    "JournalPeriod.toJson",
    "Stats.completedSetsOf",
    "Stats.of",
    "Tag.canAdd",
    "Tag.ensureWithinLimit",
    "TagName.parse",
    "TaggedEntries.byDate",
    "TaggedEntries.merge",
    "TaggedEntries.page",
    "Tags.parse",
    "Task.complete",
    "Task.completedByJournal",
    "Task.create",
    "Task.rename",
    "Task.reopen",
    "TaskTitle.parse",
    "Timeline.build",
    "Timeline.completedSetsOn",
    "Timeline.deleteTag",
    "Timeline.entryCountOf",
    "Timeline.merge",
    "Timeline.page",
    "Timeline.putEntry",
    "Timeline.removeEntry",
    "Timeline.withCurrentSession",
    "Timeline.withDayCounted",
]

@Test("ゴールデンケースのどの関数も、Swift のテストで通すか、まだ移していないと書いてある")
func everyGoldenFunctionIsCovered() {
    let all = Set(Golden.allFunctions)
    #expect(!all.isEmpty, "ゴールデンケースが見つからない: \(goldenDirectory.path)")
    #expect(all.subtracting(Golden.loaded).subtracting(notYetPorted).sorted() == [])
    #expect(notYetPorted.intersection(Golden.loaded).sorted() == [], "移したのにまだ書いてある")
    #expect(notYetPorted.subtracting(all).sorted() == [], "ゴールデンケースにない関数")
}
