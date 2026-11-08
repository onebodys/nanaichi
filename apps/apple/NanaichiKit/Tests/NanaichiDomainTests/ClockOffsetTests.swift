import Testing

@testable import NanaichiDomain

private struct Measure: Decodable {
    let requestedAt: Instant
    let receivedAt: Instant
    let serverTime: Instant
}

private struct ServerNow: Decodable {
    let offset: ClockOffset
    let deviceNow: Instant
    let snapshotServerTime: Instant
}

@Test("ClockOffset.measure", arguments: Golden.cases("ClockOffset.measure"))
func measureCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, Measure.self) {
        ClockOffset.measure(
            .init(requestedAt: $0.requestedAt, receivedAt: $0.receivedAt, serverTime: $0.serverTime))
    }
}

@Test("ClockOffset.serverNow", arguments: Golden.cases("ClockOffset.serverNow"))
func serverNowCases(_ golden: GoldenCase) throws {
    try Golden.check(golden, ServerNow.self) {
        $0.offset.serverNow(deviceNow: $0.deviceNow, snapshotServerTime: $0.snapshotServerTime)
    }
}

@Test("往復の中間が 0.5 ミリ秒に落ちても、TS と同じく端数を残して測り、サーバーの時刻は 0 の側に切り捨てる")
func halfMillisecondOffset() {
    let offset = ClockOffset.measure(
        .init(
            requestedAt: Instant(milliseconds: 0), receivedAt: Instant(milliseconds: 1),
            serverTime: Instant(milliseconds: 100)))
    #expect(offset.serverAheadMs == 99.5)
    #expect(
        offset.serverNow(deviceNow: Instant(milliseconds: 10), snapshotServerTime: Instant(milliseconds: 0))
            == Instant(milliseconds: 109))
}
