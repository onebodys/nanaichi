import Foundation
import Testing

@testable import NanaichiDomain

private func decode<T: Decodable>(_: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

@Test(
    "API の応答として形の違う値は読まない（valibot のスキーマと同じ）",
    arguments: [
        #"{"kind":"Focus","round":0,"setNumber":1,"completedSets":0,"remainingSeconds":1,"clock":{"kind":"Running","endsAt":"2026-10-17T00:07:00.000Z"}}"#,
        #"{"kind":"Idle","round":1,"setNumber":1,"completedSets":-1}"#,
        #"{"kind":"Break","round":1,"completedSets":0,"remainingSeconds":1,"clock":{"kind":"Stopped"}}"#,
        #"{"kind":"Waiting","round":1}"#,
    ])
func rejectsMalformedTimerState(_ json: String) {
    #expect(throws: DecodingError.self) { try decode(TimerState.self, json) }
}

@Test("ID は UUID の形でなければ読まない")
func rejectsMalformedIds() throws {
    #expect(throws: DecodingError.self) { try decode([SessionId].self, #"["not-a-uuid"]"#) }
    #expect(throws: DecodingError.self) {
        try decode([SessionEventId].self, #"["00000000-0000-4000-8000-00000000000g"]"#)
    }
    #expect(try decode([SessionId].self, #"["0F0E0D0C-0000-4000-8000-000000000000"]"#).count == 1)
}

@Test("操作イベントの並びは開始から始まり、開始は先頭だけ")
func sessionEventsStartWithStart() {
    #expect(throws: DecodingError.self) {
        try decode(SessionEvents.self, #"[{"kind":"Pause","at":"2026-10-17T00:00:00.000Z"}]"#)
    }
    #expect(throws: DecodingError.self) {
        try decode(
            SessionEvents.self,
            #"[{"kind":"Start","at":"2026-10-17T00:00:00.000Z"},{"kind":"Start","at":"2026-10-17T00:01:00.000Z"}]"#
        )
    }
}
