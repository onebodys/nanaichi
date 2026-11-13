import Foundation
import Testing

@testable import NanaichiAccount
@testable import NanaichiDomain

// 取り込みの束を送る（`POST /api/imports`、ADR 0020）。束の形そのものは NanaichiDomainTests の ImportTests が確かめる

private func backend(_ stub: StubServer) -> AccountBackend {
    AccountBackend(
        token: token, server: server, session: stub.session, openSocket: FakeSockets().open,
        scheduler: ManualScheduler(), onSignedOut: {})
}

private let sessionId = SessionId("00000000-0000-4000-8000-000000000101")!

private let batch = ImportBatch(
    sessions: [
        ClosedSession(
            id: sessionId,
            events: RecordedSessionEvents(
                start: RecordedSessionEvent(
                    id: SessionEventId("00000000-0000-4000-8000-000000000201")!,
                    event: Start(at: Instant(iso8601: "2100-01-01T00:00:00.000Z")!)),
                operations: []),
            entries: [], endedAt: Instant(iso8601: "2100-01-01T00:20:00.000Z")!, endedBy: .end)
    ],
    advanceModeChanges: [])

@Suite("取り込みの束を送る")
struct AccountImportTests {
    @Test("束を Bearer のトークンを付けて POST /api/imports に送り、セッションごとの結果を読む")
    func sendsBatch() async throws {
        let stub = StubServer(.text(200, #"{"outcomes":[{"sessionId":"\#(sessionId.rawValue)","kind":"Imported"}]}"#))

        let receipt = await backend(stub).sendImportBatch(batch)

        #expect(receipt == .success(ImportReceipt(outcomes: [SessionImportOutcome(sessionId: sessionId, kind: .imported)])))
        let request = try #require(stub.requests.only)
        #expect(request.method == "POST")
        #expect(request.path == "/api/imports")
        #expect(request.headers["Authorization"] == "Bearer token-123")
        #expect(request.body.flatMap(canonicalJSON) == canonicalJSON(try JSONEncoder().encode(batch)))
    }

    @Test("送りすぎ（429）は Retry-After の秒をミリ秒にして返し、読めなければ10秒")
    func rateLimited() async {
        let body = Data(#"{"error":"RATE_LIMITED"}"#.utf8)
        let withHeader = StubServer(.http(status: 429, body: body, headers: ["Retry-After": "10"]))
        let withoutHeader = StubServer(.http(status: 429, body: body))

        #expect(await backend(withHeader).sendImportBatch(batch) == .failure(.rateLimited(retryAfterMs: 10_000)))
        #expect(await backend(withoutHeader).sendImportBatch(batch) == .failure(.rateLimited(retryAfterMs: 10_000)))
    }

    @Test("開いているセッションを含む束などの想定内の失敗は、エラーの本文の種類で断られる")
    func rejected() async {
        let stub = StubServer(.text(400, #"{"error":"INVALID_REQUEST"}"#))

        #expect(await backend(stub).sendImportBatch(batch) == .failure(.backend(.rejected(.invalidRequest))))
    }

    @Test("サーバーに届かなければ unreachable")
    func unreachable() async {
        #expect(await backend(StubServer(.unreachable)).sendImportBatch(batch) == .failure(.backend(.unreachable)))
    }
}
