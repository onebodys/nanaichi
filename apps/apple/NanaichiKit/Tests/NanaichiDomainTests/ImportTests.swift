import Foundation
import Testing

@testable import NanaichiDomain

// 取り込み（ADR 0020）で送る形。`Fixtures/import-batch.json` は、Web のサーバーの検証
// （`ImportBatchJsonSchema`）が受け付けることを TS のテスト（`apps/web/src/domain/import.test.ts`）でも確かめている

private func at(_ text: String) -> Instant { Instant(iso8601: text)! }
private func uuid(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }
private func sessionId(_ n: Int) -> SessionId { SessionId(uuid(n))! }
private func eventId(_ n: Int) -> SessionEventId { SessionEventId(uuid(n))! }
private func entryId(_ n: Int) -> JournalEntryId { JournalEntryId(uuid(n))! }

private func operation(_ n: Int, _ kind: SessionOperationKind, _ time: String) -> RecordedSessionEvent<SessionOperation> {
    RecordedSessionEvent(id: eventId(n), event: SessionOperation(kind: kind, at: at(time)))
}

private func closed(
    _ id: Int, startEvent: Int, startedAt: String, operations: [RecordedSessionEvent<SessionOperation>] = [],
    entries: [StoredEntry] = [], endedAt: String, endedBy: EndedBy
) -> ClosedSession {
    ClosedSession(
        id: sessionId(id),
        events: RecordedSessionEvents(
            start: RecordedSessionEvent(id: eventId(startEvent), event: Start(at: at(startedAt))), operations: operations),
        entries: entries, endedAt: at(endedAt), endedBy: endedBy)
}

private let written = JournalEntry(
    id: entryId(301), sessionId: sessionId(101), body: JournalEntryBody("設計を読んだ")!, tags: [TagName("reading")!],
    writtenAt: at("2100-01-01T00:02:00.000Z"), updatedAt: at("2100-01-01T00:05:00.000Z"),
    writtenDuring: .focus(round: 1, setNumber: 1))

private let batch = ImportBatch(
    sessions: [
        closed(
            101, startEvent: 201, startedAt: "2100-01-01T00:00:00.000Z",
            operations: [
                operation(202, .pause, "2100-01-01T00:03:00.000Z"),
                operation(203, .resume, "2100-01-01T00:04:00.000Z"),
                operation(204, .end, "2100-01-01T00:20:00.000Z"),
            ],
            entries: [
                .written(written),
                .deleted(
                    DeletedJournalEntry(id: entryId(302), deletedAt: at("2100-01-01T00:10:00.000Z")),
                    sessionId: sessionId(101), writtenAt: at("2100-01-01T00:08:00.000Z")),
            ],
            endedAt: "2100-01-01T00:20:00.000Z", endedBy: .end),
        closed(
            102, startEvent: 205, startedAt: "2100-01-01T01:00:00.000Z", endedAt: "2100-01-01T01:02:00.000Z",
            endedBy: .autoEnd),
    ],
    advanceModeChanges: [
        AdvanceModeChange(
            at: at("2099-12-31T23:00:00.000Z"),
            mode: AdvanceMode(focusToJournal: .manual, journalToFocus: .auto, journalToBreak: .auto, breakToFocus: .auto))
    ])

@Test("取り込みの束は、Web のサーバーが受け付ける形（記入の本文を取り出し、削除した記入は印だけ）で送る")
func importBatchMatchesServerFormat() throws {
    let url = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Fixtures/import-batch.json")
    let expected = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(batch))
    #expect(encoded.matches(expected), "送る形: \(encoded)")
}

@Test("取り込みの応答を読み、アカウントに入ったセッション（取り込んだ・すでにあった）と、重なったセッションの数を出す")
func receiptAcceptedIds() throws {
    let receipt = try JSONDecoder().decode(
        ImportReceipt.self,
        from: Data(
            """
            {"outcomes":[
              {"sessionId":"\(uuid(101))","kind":"Imported"},
              {"sessionId":"\(uuid(102))","kind":"AlreadyImported"},
              {"sessionId":"\(uuid(103))","kind":"Overlapping"}
            ]}
            """.utf8))
    #expect(receipt.acceptedIds == [sessionId(101), sessionId(102)])
    #expect(receipt.overlappingCount == 1)
}

@Test("知らない結果の種類が入った応答は読まない")
func receiptRejectsUnknownKind() {
    #expect(throws: (any Error).self) {
        try JSONDecoder().decode(
            ImportReceipt.self, from: Data(#"{"outcomes":[{"sessionId":"\#(uuid(101))","kind":"Merged"}]}"#.utf8))
    }
}

@Test("確かめに出す数は、セッションの数と削除していない記入の数")
func summaryCountsWrittenEntries() {
    #expect(Import.summaryOf(batch.sessions) == ImportSummary(sessions: 2, entries: 1))
}

@Test("束は100セッションまでで分け、順を保ち、どの束にも進め方の履歴を全部持たせる")
func batchesSplitByCount() throws {
    let sessions = (1...205).map { n in
        closed(
            1000 + n, startEvent: 5000 + n, startedAt: Instant(milliseconds: Int64(n) * 3_600_000).iso8601,
            endedAt: Instant(milliseconds: Int64(n) * 3_600_000 + 60_000).iso8601, endedBy: .end)
    }
    let batches = try Import.batches(sessions, advanceModeChanges: batch.advanceModeChanges)
    #expect(batches.map(\.sessions.count) == [100, 100, 5])
    #expect(batches.flatMap(\.sessions) == sessions)
    #expect(batches.allSatisfy { $0.advanceModeChanges == batch.advanceModeChanges })
}

@Test("取り込むセッションがなければ束はない")
func noBatchesWithoutSessions() throws {
    #expect(try Import.batches([], advanceModeChanges: batch.advanceModeChanges).isEmpty)
}

@Test("記録を取り込んだという同期メッセージは中身がなく、読んで送り直すと同じ形になる")
func recordsImportedMessage() throws {
    #expect(SyncMessage.deserialize(#"{"kind":"RecordsImported"}"#) == .recordsImported)
    #expect(try SyncMessage.recordsImported.serialize() == #"{"kind":"RecordsImported"}"#)
}
