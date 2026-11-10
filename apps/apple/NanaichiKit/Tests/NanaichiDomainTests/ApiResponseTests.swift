import Foundation
import Testing

@testable import NanaichiDomain

/// Web の API の実際の応答と同期メッセージ（`Fixtures/api-responses.json`、作り方は `Fixtures/README.md`）
private let responses: [String: JSONValue] = {
    let url = URL(filePath: #filePath).deletingLastPathComponent().appending(
        path: "Fixtures/api-responses.json")
    do {
        guard case .object(let all) = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        else {
            fatalError("応答の例がオブジェクトではない: \(url.path)")
        }
        return all
    } catch {
        fatalError("応答の例を読めない: \(url.path) \(error)")
    }
}()

private func body(_ name: String) throws -> JSONValue {
    guard case .object(let response) = responses[name], let body = response["body"] else {
        throw InvalidInput(description: "応答の例がない: \(name)")
    }
    return body
}

/// 応答をドメインの型に戻し、JSON に書き直すと同じ形になる（サーバーと同じ形で読み書きしている）
private func roundTrips<T: Codable>(_ type: T.Type, _ json: JSONValue) throws -> T {
    let decoded = try JSONDecoder().decode(T.self, from: JSONEncoder().encode(json))
    let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(decoded))
    #expect(encoded.matches(json), "\(T.self)\n書き直した形: \(encoded)\n応答: \(json)")
    return decoded
}

private var decoders: [(name: String, type: any Codable.Type)] {
    [
        ("noSession", SessionSnapshot.self),
        ("startSession", SessionSnapshot.self),
        ("pause", SessionSnapshot.self),
        ("current", SessionSnapshot.self),
        ("writeEntry", JournalEntry.self),
        ("writeEntry2", JournalEntry.self),
        ("timeline", TimelinePage.self),
        ("stats", StatsReport.self),
        ("statsAll", StatsReport.self),
        ("journalCalendar", JournalCalendar.self),
        ("entriesOnDate", EntriesOnDate.self),
        ("entriesByTag", TaggedEntriesPage.self),
        ("tags", TagList.self),
        ("tagUsage", TagUsageList.self),
        ("deleteTag", DeletedTag.self),
        ("deleteEntry", DeletedJournalEntry.self),
        ("advanceMode", AdvanceMode.self),
        ("taskSetting", TaskSetting.self),
        ("createTask", TodoTask.self),
        ("completeTask", TodoTask.self),
        ("tasks", TaskList.self),
        ("deleteTask", DeletedTask.self),
    ]
}

@Test("Web の API の応答を、ドメインの型に戻して同じ形に書き直せる", arguments: decoders.map(\.name))
func decodesApiResponse(_ name: String) throws {
    let type = try #require(decoders.first { $0.name == name }).type
    _ = try roundTrips(type, try body(name))
}

@Test(
    "エラーの応答は種類を読み、補足のフィールドは読み飛ばす",
    arguments: [
        ("unauthenticated", ApiErrorCode.unauthenticated),
        ("rejected", .operationRejected),
        ("taskNotFound", .taskNotFound),
        ("invalid", .invalidRequest),
    ])
func decodesApiError(_ name: String, _ code: ApiErrorCode) throws {
    let decoded = try JSONDecoder().decode(ApiErrorBody.self, from: JSONEncoder().encode(try body(name)))
    #expect(decoded.error == code)
}

@Test("同期メッセージは、届いた文字列から読み、送る文字列にすると同じ形になる")
func decodesSyncMessages() throws {
    guard case .array(let messages) = responses["syncMessages"] else {
        throw InvalidInput(description: "同期メッセージの例がない")
    }
    #expect(messages.count == 15)
    var kinds: [String] = []
    for message in messages {
        let text = String(decoding: try JSONEncoder().encode(message), as: UTF8.self)
        let decoded = try #require(SyncMessage.deserialize(text), "\(text)")
        let reencoded = try JSONDecoder().decode(JSONValue.self, from: Data(try decoded.serialize().utf8))
        #expect(reencoded.matches(message))
        if case .object(let fields) = message, case .string(let kind) = fields["kind"] { kinds.append(kind) }
    }
    #expect(
        Set(kinds) == [
            "SessionChanged", "JournalEntrySaved", "JournalEntryDeleted", "TagDeleted", "AdvanceModeChanged",
            "TaskSaved", "TaskDeleted", "TaskSettingChanged",
        ])
}

@Test("記入を書いた応答の本文とタグは、検証してドメインの型に戻る")
func decodedEntryKeepsBodyAndTags() throws {
    let entry = try roundTrips(JournalEntry.self, try body("writeEntry2"))
    #expect(entry.body.unwrap() == "ふりかえり\n2行目")
    #expect(entry.tags.map(\.rawValue) == ["reading"])
}

@Test("形の合わない同期メッセージは読まない")
func rejectsMalformedSyncMessage() {
    #expect(SyncMessage.deserialize("not json") == nil)
    #expect(SyncMessage.deserialize(#"{"kind":"Unknown"}"#) == nil)
    #expect(SyncMessage.deserialize(#"{"kind":"TaskSettingChanged","setting":{"kind":"Maybe"}}"#) == nil)
    #expect(
        SyncMessage.deserialize(
            #"{"kind":"TagDeleted","deleted":{"name":"a b","deletion":{"kind":"Detach"}}}"#) == nil)
}

@Test("スタッツの時間帯が24個でなければ読まない")
func rejectsStatsWithWrongHours() throws {
    guard case .object(var report) = try body("stats"), case .object(var activity) = report["activity"] else {
        throw InvalidInput(description: "スタッツの例の形が違う")
    }
    activity["hours"] = .array([.number(0)])
    report["activity"] = .object(activity)
    #expect(throws: DecodingError.self) {
        try JSONDecoder().decode(StatsReport.self, from: JSONEncoder().encode(JSONValue.object(report)))
    }
}
