import Foundation
import Synchronization
import Testing

@testable import NanaichiAccount
@testable import NanaichiDomain

// Web の `apps/web/src/client/remote-backend.test.ts` と `task-api.test.ts` に当たるもの。
// サーバーの代わり（URLProtocol）に、Web の API の実際の応答（api-responses.json）を返させる

private let entryId = JournalEntryId("00000000-0000-4000-8000-000000000901")!
private let eventId = SessionEventId("d3c06e6e-1dc4-4fd8-81fd-000000000001")!
private let taskId = TaskId("00000000-0000-4000-8000-000000000001")!
private let reading = TagName("reading")!
private let design = TagName("設計")!
private let tokyo = TimeZoneName("Asia/Tokyo")!
private let before = Instant(iso8601: "2100-01-01T00:09:00.000Z")!

private func backend(_ stub: StubServer, onSignedOut: @escaping @Sendable () -> Void = {}) -> AccountBackend {
    AccountBackend(
        token: token, server: server, session: stub.session, openSocket: FakeSockets().open,
        scheduler: ManualScheduler(), onSignedOut: onSignedOut)
}

/// 1つの API の呼び出し。送るリクエストと、受け取った応答をドメインの型に戻した結果
struct ApiCall: Sendable, CustomTestStringConvertible {
    let name: String
    let method: String
    let path: String
    var query: String? = nil
    var body: String? = nil
    let fixture: String
    /// 呼び出し、応答の例をドメインの型に戻したものと同じ値が返ったか
    let run: @Sendable (AccountBackend, String) async -> Bool

    var testDescription: String { name }
}

private func returns<T: Decodable & Equatable>(_ result: Result<T, BackendError>, _ fixture: String) -> Bool {
    result == .success(decoded(T.self, fixture))
}

private let calls: [ApiCall] = [
    ApiCall(
        name: "現在のセッション", method: "GET", path: "/api/session/current", fixture: "current",
        run: { returns(await $0.getCurrentSession(), $1) }),
    ApiCall(
        name: "開始", method: "POST", path: "/api/session", body: #"{"id":"\#(eventId.rawValue)"}"#,
        fixture: "startSession", run: { returns(await $0.startSession(id: eventId), $1) }),
    ApiCall(
        name: "一時停止", method: "POST", path: "/api/session/commands",
        body: #"{"id":"\#(eventId.rawValue)","kind":"Pause"}"#, fixture: "pause",
        run: { returns(await $0.operateSession(id: eventId, kind: .pause), $1) }),
    ApiCall(
        name: "ジャーナル記入を書く", method: "POST", path: "/api/journal-entries",
        body: #"{"id":"\#(entryId.rawValue)","body":"設計を読んだ","tags":["reading","設計"]}"#, fixture: "writeEntry",
        run: { returns(await $0.writeJournalEntry(id: entryId, body: "設計を読んだ", tags: [reading, design]), $1) }),
    ApiCall(
        name: "ジャーナル記入を編集する", method: "PATCH", path: "/api/journal-entries/\(entryId.rawValue)",
        body: #"{"body":"ふりかえり","tags":["reading"]}"#, fixture: "writeEntry2",
        run: { returns(await $0.editJournalEntry(id: entryId, body: "ふりかえり", tags: [reading]), $1) }),
    ApiCall(
        name: "ジャーナル記入を削除する", method: "DELETE", path: "/api/journal-entries/\(entryId.rawValue)",
        fixture: "deleteEntry", run: { returns(await $0.deleteJournalEntry(id: entryId), $1) }),
    ApiCall(
        name: "タイムラインの最新のページ", method: "GET", path: "/api/timeline", fixture: "timeline",
        run: { returns(await $0.getTimeline(before: nil), $1) }),
    ApiCall(
        name: "タイムラインの前のページ", method: "GET", path: "/api/timeline",
        query: "before=2100-01-01T00%3A09%3A00.000Z", fixture: "timeline",
        run: { returns(await $0.getTimeline(before: before), $1) }),
    ApiCall(
        name: "タグ", method: "GET", path: "/api/tags", fixture: "tags", run: { returns(await $0.getTags(), $1) }),
    ApiCall(
        name: "タグの記入の数", method: "GET", path: "/api/tags/usage", fixture: "tagUsage",
        run: { returns(await $0.getTagUsage(), $1) }),
    ApiCall(
        name: "タグの削除（付け替え）", method: "DELETE", path: "/api/tags/%E8%A8%AD%E8%A8%88",
        body: #"{"kind":"Reassign","to":"reading"}"#, fixture: "deleteTag",
        run: { returns(await $0.deleteTag(name: design, deletion: .reassign(to: reading)), $1) }),
    ApiCall(
        name: "スタッツ（タイムゾーンの + を符号化する）", method: "GET", path: "/api/stats",
        query: "period=Week&timeZone=Etc%2FGMT%2B9", fixture: "stats",
        run: { returns(await $0.getStats(period: .week, timeZone: TimeZoneName("Etc/GMT+9")!), $1) }),
    ApiCall(
        name: "ジャーナルのカレンダー", method: "GET", path: "/api/journal-calendar",
        query: "month=2100-01&timeZone=Asia%2FTokyo", fixture: "journalCalendar",
        run: { returns(await $0.getJournalCalendar(month: JournalMonth(year: 2100, month: 1)!, timeZone: tokyo), $1) }),
    ApiCall(
        name: "日付の記入", method: "GET", path: "/api/journal-entries/by-date",
        query: "date=2100-01-01&timeZone=Asia%2FTokyo", fixture: "entriesOnDate",
        run: { returns(await $0.getEntriesOnDate(date: LocalDate(year: 2100, month: 1, day: 1), timeZone: tokyo), $1) }),
    ApiCall(
        name: "タグのついた記入", method: "GET", path: "/api/journal-entries/by-tag",
        query: "tag=reading&before=2100-01-01T00%3A09%3A00.000Z", fixture: "entriesByTag",
        run: { returns(await $0.getEntriesWithTag(tag: reading, before: before), $1) }),
    ApiCall(
        name: "フェーズの進め方", method: "GET", path: "/api/settings/advance-mode", fixture: "advanceMode",
        run: { returns(await $0.getAdvanceMode(), $1) }),
    ApiCall(
        name: "フェーズの進め方を変える", method: "PUT", path: "/api/settings/advance-mode",
        body: #"{"FocusToJournal":"Manual","JournalToFocus":"Auto","JournalToBreak":"Auto","BreakToFocus":"Auto"}"#,
        fixture: "advanceMode",
        run: { returns(await $0.changeAdvanceMode(decoded(AdvanceMode.self, "advanceMode")), $1) }),
    ApiCall(
        name: "ToDo の設定", method: "GET", path: "/api/settings/tasks", fixture: "taskSetting",
        run: { returns(await $0.getTaskSetting(), $1) }),
    ApiCall(
        name: "ToDo の設定を変える", method: "PUT", path: "/api/settings/tasks", body: #"{"kind":"Enabled"}"#,
        fixture: "taskSetting", run: { returns(await $0.changeTaskSetting(.enabled), $1) }),
    ApiCall(
        name: "タスクの一覧", method: "GET", path: "/api/tasks", fixture: "tasks",
        run: { returns(await $0.getTasks(), $1) }),
    ApiCall(
        name: "タスクを作る", method: "POST", path: "/api/tasks",
        body: #"{"id":"\#(taskId.rawValue)","title":"README の更新"}"#, fixture: "createTask",
        run: { returns(await $0.createTask(id: taskId, title: TaskTitle("README の更新")!), $1) }),
    ApiCall(
        name: "タスクのタイトルを変える", method: "PATCH", path: "/api/tasks/\(taskId.rawValue)",
        body: #"{"title":"README の更新"}"#, fixture: "createTask",
        run: { returns(await $0.renameTask(id: taskId, title: TaskTitle("README の更新")!), $1) }),
    ApiCall(
        name: "タスクを完了にする", method: "POST", path: "/api/tasks/\(taskId.rawValue)/complete",
        fixture: "completeTask", run: { returns(await $0.completeTask(id: taskId), $1) }),
    ApiCall(
        name: "タスクを再開する", method: "POST", path: "/api/tasks/\(taskId.rawValue)/reopen",
        fixture: "createTask", run: { returns(await $0.reopenTask(id: taskId), $1) }),
    ApiCall(
        name: "タスクを削除する", method: "DELETE", path: "/api/tasks/\(taskId.rawValue)", fixture: "deleteTask",
        run: { returns(await $0.deleteTask(id: taskId), $1) }),
]

@Suite("アカウントの記録先")
struct AccountBackendTests {
    @Test("Web と同じリクエストを Bearer のトークンを付けて送り、応答をドメインの型で読む", arguments: calls)
    func request(_ call: ApiCall) async throws {
        let stub = StubServer(fixture(call.fixture))

        #expect(await call.run(backend(stub), call.fixture))

        let request = try #require(stub.requests.only)
        #expect(request.method == call.method)
        #expect(request.path == call.path)
        #expect(request.query == call.query)
        #expect(request.headers["Authorization"] == "Bearer token-123")
        #expect(request.headers["Content-Type"] == (call.body == nil ? nil : "application/json"))
        #expect(request.body.flatMap(canonicalJSON) == call.body.flatMap(canonicalJSON))
    }

    @Test("ログインが切れていたら UNAUTHENTICATED で断られ、失敗を返す前にログアウトを知らせる")
    func unauthenticated() async {
        let signedOut = Counter()
        let backend = backend(StubServer(fixture("unauthenticated")), onSignedOut: signedOut.increment)

        #expect(await backend.getCurrentSession() == .failure(.rejected(.unauthenticated)))
        #expect(await backend.getTasks() == .failure(.rejected(.unauthenticated)))
        #expect(signedOut.value == 2)
    }

    @Test(
        "想定内の失敗はエラーの本文の種類で断られ、ログアウトは知らせない",
        arguments: [
            ("rejected", ApiErrorCode.operationRejected), ("taskNotFound", .taskNotFound), ("invalid", .invalidRequest),
        ])
    func rejected(_ name: String, _ code: ApiErrorCode) async {
        let signedOut = Counter()
        let backend = backend(StubServer(fixture(name)), onSignedOut: signedOut.increment)

        #expect(await backend.operateSession(id: eventId, kind: .pause) == .failure(.rejected(code)))
        #expect(signedOut.value == 0)
    }

    @Test("ログインしている人の名前とメールアドレスを読み、メールアドレスは伏せて持つ")
    func me() async {
        // apps/web/src/server/app.ts の `/me` が返す形
        let stub = StubServer(
            .text(200, #"{"user":{"id":"u1","name":"おのり","email":"owner@example.com","image":null}}"#))

        let user = await backend(stub).getMe()

        #expect(user == .success(AccountUser(name: "おのり", email: Sensitive("owner@example.com"))))
        #expect(stub.requests.only?.path == "/api/me")
        #expect(stub.requests.only?.headers["Authorization"] == "Bearer token-123")
        #expect(!String(describing: user).contains("owner@example.com"))
    }

    @Test("サーバーに届かなければ unreachable")
    func unreachable() async {
        #expect(await backend(StubServer(.unreachable)).getTags() == .failure(.unreachable))
    }

    @Test(
        "応答がドメインの型にもエラーの本文にも合わなければ broken",
        arguments: [
            ("JSON でない成功", StubResponse.text(200, "<html>")),
            ("形の違う成功", .text(200, #"{"tags":[1]}"#)),
            ("JSON でない失敗", .text(502, "Bad Gateway")),
            ("知らない種類の失敗", .text(409, #"{"error":"SOMETHING_NEW"}"#)),
        ])
    func broken(_: String, _ response: StubResponse) async {
        #expect(await backend(StubServer(response)).getTags() == .failure(.broken))
    }
}

@Suite("時計のずれ")
struct ClockOffsetMeasurementTests {
    /// 呼ばれるたびに次の時刻を返す端末の時計
    final class SteppingClock: Sendable {
        private let times: Mutex<[Instant]>
        init(_ times: [Instant]) { self.times = Mutex(times) }
        func now() -> Instant { times.withLock { $0.removeFirst() } }
    }

    @Test("スナップショットを受け取ると、送ってから受け取るまでの中間とサーバーの時刻の差を時計のずれにする")
    func measures() async {
        // current の serverTime は 2100-01-01T00:09:00.000Z
        let serverTime = Instant(iso8601: "2100-01-01T00:09:00.000Z")!
        let clock = SteppingClock([serverTime.adding(milliseconds: -5_000), serverTime.adding(milliseconds: -4_000)])
        let backend = AccountBackend(
            token: token, server: server, session: StubServer(fixture("current")).session, clock: clock.now,
            openSocket: FakeSockets().open, scheduler: ManualScheduler(), onSignedOut: {})

        #expect(await backend.clockOffset() == ClockOffset(serverAheadMs: 0))
        _ = await backend.getCurrentSession()
        #expect(await backend.clockOffset() == ClockOffset(serverAheadMs: 4_500))
    }

    @Test("スナップショットを受け取れなかったら、前に測った時計のずれのまま")
    func keepsOnFailure() async {
        let serverTime = Instant(iso8601: "2100-01-01T00:09:00.000Z")!
        let clock = SteppingClock([
            serverTime.adding(milliseconds: -1_000), serverTime, serverTime, serverTime,
        ])
        let responses = Mutex([fixture("current"), StubResponse.unreachable])
        let stub = StubServer { _ in responses.withLock { $0.removeFirst() } }
        let backend = AccountBackend(
            token: token, server: server, session: stub.session, clock: clock.now, openSocket: FakeSockets().open,
            scheduler: ManualScheduler(), onSignedOut: {})

        _ = await backend.getCurrentSession()
        #expect(await backend.getCurrentSession() == .failure(.unreachable))
        #expect(await backend.clockOffset() == ClockOffset(serverAheadMs: 500))
    }
}

extension Array {
    /// 要素が1つだけならそれ
    var only: Element? { count == 1 ? first : nil }
}
