import Foundation
import Synchronization
import Testing

@testable import NanaichiAccount
@testable import NanaichiDomain

// Web の `apps/web/src/client/sync-connection.test.ts` と同じ場面を、アカウントの記録先の `subscribe` で確かめる。
// WebSocket は差し替え、タイマーは時計を進めて動かす

private final class Harness: Sendable {
    let sockets = FakeSockets()
    let scheduler: ManualScheduler
    let backend: AccountBackend
    /// 受け取り始めたストリーム。ストリームを手放すと受け取るのをやめて接続を閉じるので、テストのあいだ持っておく
    private let streams = Mutex<[AsyncStream<SyncEvent>]>([])

    init(scheduler: ManualScheduler = ManualScheduler()) {
        self.scheduler = scheduler
        backend = AccountBackend(
            token: token, server: server, session: StubServer(.unreachable).session, openSocket: sockets.open,
            scheduler: scheduler, onSignedOut: {})
    }

    func subscribe() async -> AsyncStream<SyncEvent>.AsyncIterator {
        let stream = await backend.subscribe()
        streams.withLock { $0.append(stream) }
        return stream.makeAsyncIterator()
    }
}

private func message(_ index: Int) -> SyncEvent {
    guard let message = SyncMessage.deserialize(syncMessageText(index)) else { fatalError("同期メッセージとして読めない") }
    return .message(message)
}

/// 期限が来るまでの待ち時間を、1ミリ秒前と期限ちょうどで確かめる
private func reconnects(after delay: Int64, _ harness: Harness) async -> Bool {
    let count = harness.sockets.all.count
    await harness.scheduler.advance(by: delay - 1)
    guard harness.sockets.all.count == count else { return false }
    await harness.scheduler.advance(by: 1)
    return harness.sockets.all.count == count + 1
}

@Suite("同期メッセージの接続")
struct SyncConnectionTests {
    @Test("繋がったら読み込み直すよう知らせる")
    func connected() async {
        let harness = Harness()
        var events = await harness.subscribe()

        #expect(harness.sockets.all.count == 1)
        await harness.sockets.last.emit(.opened)
        #expect(await events.next() == .connected)
    }

    @Test("届いた同期メッセージを検証して渡し、合わないものと pong は捨てる")
    func messages() async {
        let harness = Harness()
        var events = await harness.subscribe()
        let socket = harness.sockets.last
        await socket.emit(.opened)
        _ = await events.next()

        await socket.emit(.text("not json"))
        await socket.emit(.text(#"{"kind":"Unknown"}"#))
        await socket.emit(.text("pong"))
        await socket.emit(.text(syncMessageText(0)))
        await socket.emit(.text(syncMessageText(11)))

        #expect(await events.next() == message(0))
        #expect(await events.next() == message(11))
    }

    @Test("切れたら1秒後に繋ぎ直し、繋がったらまた読み込み直すよう知らせる")
    func reconnect() async {
        let harness = Harness()
        var events = await harness.subscribe()
        await harness.sockets.last.emit(.opened)
        #expect(await events.next() == .connected)

        await harness.sockets.last.emit(.closed)
        #expect(await reconnects(after: 1000, harness))
        await harness.sockets.last.emit(.opened)
        #expect(await events.next() == .connected)
    }

    @Test("繋がらないまま失敗が続くと、間隔を倍にしながら最大30秒まで延ばし、繋がったら1秒に戻る")
    func backoff() async {
        let harness = Harness()
        _ = await harness.subscribe()

        for delay: Int64 in [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000] {
            await harness.sockets.last.emit(.closed)
            #expect(await reconnects(after: delay, harness), "\(delay) ミリ秒後に繋ぎ直す")
        }
        await harness.sockets.last.emit(.opened)
        await harness.sockets.last.emit(.closed)
        #expect(await reconnects(after: 1000, harness))
    }

    @Test("25秒ごとに ping を送り、pong が返れば繋いだまま")
    func pingPong() async {
        let harness = Harness()
        _ = await harness.subscribe()
        let socket = harness.sockets.last
        await socket.emit(.opened)

        await harness.scheduler.advance(by: 24_999)
        #expect(socket.sent.isEmpty)
        await harness.scheduler.advance(by: 1)
        #expect(socket.sent == ["ping"])
        await socket.emit(.text("pong"))
        await harness.scheduler.advance(by: 25_000)

        #expect(socket.sent == ["ping", "ping"])
        #expect(!socket.closed)
        #expect(harness.sockets.all.count == 1)
    }

    @Test("ping から10秒以内に pong が返らなければ切って、1秒後に繋ぎ直す")
    func pongTimeout() async {
        let harness = Harness()
        _ = await harness.subscribe()
        let first = harness.sockets.last
        await first.emit(.opened)

        await harness.scheduler.advance(by: 25_000 + 9_999)
        #expect(!first.closed)
        await harness.scheduler.advance(by: 1)
        #expect(first.closed)
        #expect(await reconnects(after: 1000, harness))
    }

    @Test("捨てた接続から遅れて届いたメッセージや切断は無視する")
    func ignoresDiscarded() async {
        let harness = Harness()
        var events = await harness.subscribe()
        let first = harness.sockets.last
        await first.emit(.opened)
        #expect(await events.next() == .connected)
        await harness.scheduler.advance(by: 35_000)
        #expect(first.closed)
        await harness.scheduler.advance(by: 1000)
        let second = harness.sockets.last

        await first.emit(.text(syncMessageText(0)))
        await first.emit(.closed)
        await second.emit(.opened)
        await second.emit(.text(syncMessageText(1)))

        #expect(await events.next() == .connected)
        #expect(await events.next() == message(1))
        await harness.scheduler.advance(by: 1000)
        #expect(harness.sockets.all.count == 2)
    }

    @Test("確かめると、繋ぎ直しを待っている間なら待たずにすぐ繋ぎ直す")
    func checkWhileWaiting() async {
        let harness = Harness()
        _ = await harness.subscribe()
        await harness.sockets.last.emit(.closed)
        await harness.scheduler.advance(by: 1000)
        await harness.sockets.last.emit(.closed)

        await harness.backend.checkSyncConnection()

        #expect(harness.sockets.all.count == 3)
        // 失敗の回数も数え直すので、次に切れたら1秒後に繋ぎ直す
        await harness.sockets.last.emit(.closed)
        #expect(await reconnects(after: 1000, harness))
    }

    @Test("止めた繋ぎ直しのタイマーが遅れて動いても、次の繋ぎ直しを早めない")
    func staleTimer() async {
        let harness = Harness(scheduler: ManualScheduler(firesAfterCancel: true))
        _ = await harness.subscribe()
        await harness.sockets.last.emit(.closed)
        await harness.scheduler.advance(by: 500)
        await harness.backend.checkSyncConnection()
        await harness.sockets.last.emit(.closed)

        // 止めたタイマーの期限（1000）が来ても、今の繋ぎ直し（1500）までは繋がない
        await harness.scheduler.advance(by: 500)
        #expect(harness.sockets.all.count == 2)
        await harness.scheduler.advance(by: 500)
        #expect(harness.sockets.all.count == 3)
    }

    @Test("確かめると、繋がっているなら ping を送り、pong を待っている間は重ねて送らない")
    func checkWhileOpen() async {
        let harness = Harness()
        _ = await harness.subscribe()
        let socket = harness.sockets.last
        await socket.emit(.opened)

        await harness.backend.checkSyncConnection()
        await harness.backend.checkSyncConnection()

        #expect(socket.sent == ["ping"])
        await harness.scheduler.advance(by: 10_000)
        #expect(socket.closed)
    }

    @Test("受け取るのをやめたら接続を閉じ、もう繋ぎ直さない")
    func stops() async throws {
        let harness = Harness()
        let stream = await harness.backend.subscribe()
        let socket = harness.sockets.last
        await socket.emit(.opened)
        let reader = Task {
            for await _ in stream {}
        }

        reader.cancel()
        await reader.value
        try await eventually { socket.closed }
        await socket.emit(.closed)
        await harness.scheduler.advance(by: 60_000)
        #expect(harness.sockets.all.count == 1)
    }

    @Test("受け取り始めるたびに、別の接続を張る")
    func connectionPerSubscriber() async {
        let harness = Harness()
        var menuBar = await harness.subscribe()
        var window = await harness.subscribe()
        let (first, second) = (harness.sockets.all[0], harness.sockets.all[1])

        await first.emit(.opened)
        await second.emit(.opened)
        await first.emit(.text(syncMessageText(0)))
        await second.emit(.text(syncMessageText(2)))

        #expect(await menuBar.next() == .connected)
        #expect(await menuBar.next() == message(0))
        #expect(await window.next() == .connected)
        #expect(await window.next() == message(2))
    }
}

/// 別のタスクで起きることを、条件が満たされるまで待つ（ストリームの終わりは別のタスクで知らされる）
func eventually(_ condition: () -> Bool) async throws {
    for _ in 0..<1000 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(1))
    }
    Issue.record("条件が満たされないまま待ちきれなかった")
}
