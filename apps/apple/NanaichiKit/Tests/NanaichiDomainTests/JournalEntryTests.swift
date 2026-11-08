import Foundation
import Testing

@testable import NanaichiDomain

private struct Text: Decodable { let value: String }

private struct Write: Decodable {
    let id: JournalEntryId
    let body: String
    let tags: [TagName]
    let sessionId: SessionId
    let state: TimerState
    let now: Instant
}

private struct Change: Decodable {
    let body: String
    let tags: [TagName]
}

private struct Edit: Decodable {
    let entry: JournalEntry
    let change: Change
    let now: Instant
}

private struct DeleteTag: Decodable {
    let entry: JournalEntry
    let deleted: DeletedTag
}

@Test("JournalEntryBody.parse", arguments: Golden.cases("JournalEntryBody.parse"))
func bodyParseCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Text.self) { GoldenResult(parsed: JournalEntryBody($0.value)?.unwrap()) }
}

@Test("JournalEntry.write", arguments: Golden.cases("JournalEntry.write"))
func writeCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Write.self) {
        GoldenResult(
            JournalEntry.write(
                id: $0.id, body: try parsed(JournalEntryBody($0.body)), tags: $0.tags,
                sessionId: $0.sessionId,
                state: $0.state, now: $0.now))
    }
}

@Test("JournalEntry.edit", arguments: Golden.cases("JournalEntry.edit"))
func editCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Edit.self) {
        $0.entry.edit(body: try parsed(JournalEntryBody($0.change.body)), tags: $0.change.tags, now: $0.now)
    }
}

@Test("JournalEntry.deleteTag", arguments: Golden.cases("JournalEntry.deleteTag"))
func deleteTagCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, DeleteTag.self) { $0.entry.deletingTag($0.deleted) }
}

@Test("本文は前後の JS の空白を落とし、長さは JS と同じく UTF-16 で数える")
func bodyFollowsJSRules() throws {
    #expect(JournalEntryBody("\u{3000}本文\u{FEFF}")?.unwrap() == "本文")
    #expect(JournalEntryBody(String(repeating: "あ", count: 10_000)) != nil)
    #expect(JournalEntryBody(String(repeating: "あ", count: 10_001)) == nil)
    // 絵文字1つは UTF-16 で2つと数える（JS の length）
    #expect(JournalEntryBody(String(repeating: "😀", count: 5_000)) != nil)
    #expect(JournalEntryBody(String(repeating: "😀", count: 5_001)) == nil)
}

@Test("記入を文字列にしても本文は出ない（print・debugPrint・dump・文字列への埋め込み）")
func bodyIsRedacted() throws {
    let entry = try JournalEntry.write(
        id: try parsed(JournalEntryId("00000000-0000-4000-8000-000000000901")),
        body: try parsed(JournalEntryBody("ひみつの本文")), tags: [],
        sessionId: try parsed(SessionId("00000000-0000-4000-8000-000000000000")),
        state: .idle(.init(round: 1, setNumber: 1, completedSets: 0)),
        now: Instant(milliseconds: 0)
    ).get()
    var dumped = ""
    dump(entry, to: &dumped)
    var printed = ""
    print(entry, to: &printed)
    var debugPrinted = ""
    debugPrint(entry, to: &debugPrinted)
    for text in [
        dumped, printed, debugPrinted, "\(entry)", String(reflecting: entry.body), "\(entry.body.text)",
    ] {
        #expect(!text.contains("ひみつ"), "\(text)")
        #expect(text.contains("[REDACTED]") || text.contains("JournalEntryBody"), "\(text)")
    }
}

@Test("記入を JSON にすると本文を取り出す（API の応答と同期メッセージの形）")
func entryJsonHasBody() throws {
    let json =
        #"{"id":"00000000-0000-4000-8000-000000000901","sessionId":"00000000-0000-4000-8000-000000000000","body":"本文","tags":["読書"],"writtenAt":"2026-10-17T00:03:00.000Z","updatedAt":"2026-10-17T00:03:00.000Z","writtenDuring":{"kind":"Break","round":2}}"#
    let entry = try JSONDecoder().decode(JournalEntry.self, from: Data(json.utf8))
    #expect(entry.body.unwrap() == "本文")
    #expect(entry.writtenDuring == .breakTime(round: 2))
    let encoded = String(decoding: try JSONEncoder().encode(entry), as: UTF8.self)
    #expect(encoded.contains(#""body":"本文""#))
}

@Test("空の本文は読まず、エラーの文に本文を入れない")
func invalidBodyIsRejectedWithoutLeaking() throws {
    let json =
        #"{"id":"00000000-0000-4000-8000-000000000901","sessionId":"00000000-0000-4000-8000-000000000000","body":"   ","tags":[],"writtenAt":"2026-10-17T00:03:00.000Z","updatedAt":"2026-10-17T00:03:00.000Z","writtenDuring":{"kind":"Break","round":2}}"#
    #expect(throws: DecodingError.self) { try JSONDecoder().decode(JournalEntry.self, from: Data(json.utf8)) }
}
