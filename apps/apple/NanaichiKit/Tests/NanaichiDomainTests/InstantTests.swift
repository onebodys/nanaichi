import Testing

@testable import NanaichiDomain

@Test(
    "ISO 8601 の時刻をミリ秒の端数まで同じに読み書きできる",
    arguments: [
        "2026-10-17T00:07:00.000Z", "1970-01-01T00:00:00.000Z", "1969-12-31T23:59:59.999Z",
        "2024-02-29T12:34:56.789Z", "2000-03-01T00:00:00.001Z",
    ])
func iso8601RoundTrip(_ text: String) throws {
    let instant = try #require(Instant(iso8601: text))
    #expect(instant.iso8601 == text)
}

@Test("UNIX エポックからのミリ秒で持つ")
func epochMilliseconds() throws {
    #expect(Instant(iso8601: "1970-01-01T00:00:01.500Z")?.milliseconds == 1500)
    #expect(Instant(iso8601: "2026-10-17T00:00:00Z")?.milliseconds == 1_792_195_200_000)
}

@Test("UTC でない時刻や形の違う文字列は読まない", arguments: ["2026-10-17T00:00:00+09:00", "2026-13-01T00:00:00Z", "x"])
func rejectsMalformed(_ text: String) {
    #expect(Instant(iso8601: text) == nil)
}
