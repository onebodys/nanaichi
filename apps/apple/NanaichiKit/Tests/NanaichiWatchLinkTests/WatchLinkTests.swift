import Foundation
import NanaichiDevice
import NanaichiDomain
import NanaichiPresentation
import Synchronization
import Testing

@testable import NanaichiWatchLink

private let t0 = Instant(iso8601: "2026-11-02T09:00:00.000Z")!

/// 進められる時計。iPhone の記録先がワークフローに渡す時刻
private final class TestClock: Sendable {
    private let now = Mutex(t0)
    func read() -> Instant { now.withLock { $0 } }
    func advance(minutes: Int64) { now.withLock { $0 = $0.adding(milliseconds: minutes * 60_000) } }
}

private func eventId() -> SessionEventId { SessionEventId(UUID().uuidString.lowercased())! }

/// iPhone の記録先（この端末の記録先をメモリに置いたもの）
private func phoneBackend(_ clock: TestClock) -> DeviceBackend {
    DeviceBackend(location: .inMemory, clock: { clock.read() })
}

private func snapshotOf(_ reply: PhoneMessage) -> SessionSnapshot? {
    guard case .snapshot(let received) = reply else { return nil }
    return received.snapshot
}

private func stateOf(_ reply: PhoneMessage) -> TimerState? {
    guard case .session(_, _, _, let state) = snapshotOf(reply) else { return nil }
    return state
}

@Test("Watch で開始すると iPhone の記録先でセッションが始まり、始まったスナップショットが Watch に返る")
func startFromWatch() async throws {
    let clock = TestClock()
    let backend = phoneBackend(clock)
    let reply = await replyTo(.start(id: eventId()), using: backend)
    guard case .focus(let focus) = stateOf(reply) else {
        Issue.record("集中になっていない: \(reply)")
        return
    }
    #expect(focus.round == 1 && focus.setNumber == 1)
    #expect(focus.remainingSeconds == 7 * 60)
    guard case .session(_, _, let recorded, _) = try await backend.getCurrentSession().get(),
        case .session(_, _, let returned, _) = snapshotOf(reply)
    else {
        Issue.record("iPhone の記録先にセッションがない")
        return
    }
    #expect(recorded == returned)
}

@Test("届いたか確かめられずに Watch が同じ ID で開始を頼み直しても、セッションは1つだけ始まる")
func startRetriedWithSameId() async throws {
    let clock = TestClock()
    let backend = phoneBackend(clock)
    let id = eventId()
    let first = await replyTo(.start(id: id), using: backend)
    clock.advance(minutes: 1)
    let retried = await replyTo(.start(id: id), using: backend)
    guard case .session(_, _, let firstSession, _) = snapshotOf(first),
        case .session(_, _, let retriedSession, _) = snapshotOf(retried)
    else {
        Issue.record("セッションが返っていない: \(first) / \(retried)")
        return
    }
    #expect(firstSession.id == retriedSession.id)
}

@Test("Watch で中断すると、iPhone で中断したのと同じく不成立セットになり待機に戻る")
func abortFromWatchMatchesPhone() async throws {
    let watchClock = TestClock()
    let throughWatch = phoneBackend(watchClock)
    _ = await replyTo(.start(id: eventId()), using: throughWatch)
    watchClock.advance(minutes: 3)
    let reply = await replyTo(.abort(id: eventId()), using: throughWatch)

    let phoneClock = TestClock()
    let onPhone = phoneBackend(phoneClock)
    _ = try await onPhone.startSession(id: eventId()).get()
    phoneClock.advance(minutes: 3)
    guard case .session(_, _, _, let phoneState) = try await onPhone.operateSession(id: eventId(), kind: .abort).get()
    else {
        Issue.record("iPhone で中断したあとにセッションがない")
        return
    }

    guard case .idle(let idle) = stateOf(reply) else {
        Issue.record("待機になっていない: \(reply)")
        return
    }
    #expect(idle.setNumber == 1 && idle.completedSets == 0)
    #expect(stateOf(reply) == phoneState)
}

@Test("中断できないときに Watch が中断を頼むと、断られた文言が返り、記録は変わらない")
func abortRefusedOutsideFocus() async throws {
    let backend = phoneBackend(TestClock())
    let before = try await backend.getCurrentSession().get()
    let reply = await replyTo(.abort(id: eventId()), using: backend)
    #expect(reply == .refused(message: "操作できませんでした。最新の状態を読み込み直しました。"))
    #expect(try await backend.getCurrentSession().get() == before)
}

@Test("Watch が今の様子を頼むと、iPhone の記録先の今のスナップショットが返る")
func currentSnapshot() async throws {
    let backend = phoneBackend(TestClock())
    _ = try await backend.startSession(id: eventId()).get()
    let reply = await replyTo(.current, using: backend)
    #expect(snapshotOf(reply) == (try await backend.getCurrentSession().get()))
}

@Test("頼みと答えは送る形にして戻しても同じ")
func codingRoundTrip() async throws {
    let backend = phoneBackend(TestClock())
    let reply = await replyTo(.start(id: eventId()), using: backend)
    let messages: [WatchMessage] = [.current, .start(id: eventId()), .abort(id: eventId())]
    for message in messages {
        #expect(WatchLinkCoding.decode(WatchMessage.self, from: WatchLinkCoding.encode(message)) == message)
    }
    let replies: [PhoneMessage] = [reply, .refused(message: "操作できませんでした。")]
    for reply in replies {
        #expect(WatchLinkCoding.decode(PhoneMessage.self, from: WatchLinkCoding.encode(reply)) == reply)
    }
    #expect(WatchLinkCoding.decode(WatchMessage.self, from: Data("{}".utf8)) == nil)
}
