import Testing

@testable import NanaichiDomain

private struct Text: Decodable { let value: String }

private struct Create: Decodable {
    let id: TaskId
    let title: TaskTitle
    let now: Instant
}

private struct Rename: Decodable {
    let task: TodoTask
    let title: TaskTitle
    let now: Instant
}

private struct Complete: Decodable {
    let task: OpenTask
    let completion: TaskCompletion
    let now: Instant
}

private struct Reopen: Decodable {
    let task: CompletedTask
    let now: Instant
}

private struct CompletedByJournal: Decodable {
    let tasks: [TodoTask]
    let judgments: [TaskJudgment]
    let entryId: JournalEntryId
    let now: Instant
}

@Test("TaskTitle.parse", arguments: Golden.cases("TaskTitle.parse"))
func titleParseCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Text.self) { GoldenResult(parsed: TaskTitle($0.value)) }
}

@Test("Task.create", arguments: Golden.cases("Task.create"))
func createCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Create.self) { TodoTask.create(id: $0.id, title: $0.title, now: $0.now) }
}

@Test("Task.rename", arguments: Golden.cases("Task.rename"))
func renameCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Rename.self) { $0.task.renamed($0.title, now: $0.now) }
}

@Test("Task.complete", arguments: Golden.cases("Task.complete"))
func completeCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Complete.self) { $0.task.complete($0.completion, now: $0.now) }
}

@Test("Task.reopen", arguments: Golden.cases("Task.reopen"))
func reopenCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Reopen.self) { $0.task.reopen(now: $0.now) }
}

@Test("Task.completedByJournal", arguments: Golden.cases("Task.completedByJournal"))
func completedByJournalCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, CompletedByJournal.self) {
        TodoTask.completedByJournal($0.tasks, judgments: $0.judgments, entryId: $0.entryId, now: $0.now)
    }
}
