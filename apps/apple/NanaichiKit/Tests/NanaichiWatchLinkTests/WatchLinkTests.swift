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
    func advance(minutes: Int64) { advance(seconds: minutes * 60) }
    func advance(seconds: Int64) { now.withLock { $0 = $0.adding(milliseconds: seconds * 1000) } }
}

private func eventId() -> SessionEventId { SessionEventId(UUID().uuidString.lowercased())! }

/// iPhone の記録先（この端末の記録先をメモリに置いたもの）
private func phoneBackend(_ clock: TestClock) -> DeviceBackend {
    DeviceBackend(location: .inMemory, clock: { clock.read() })
}

private let store = RecordStoreTag("device")

private func snapshotOf(_ reply: PhoneMessage) -> SessionSnapshot? {
    guard case .snapshot(let snapshot) = reply else { return nil }
    return snapshot.received.snapshot
}

private func stateOf(_ reply: PhoneMessage) -> TimerState? {
    guard case .session(_, _, _, let state) = snapshotOf(reply) else { return nil }
    return state
}

/// Watch が `reply` を受け取ってから操作するときの、画面に出しているセッション
private func sessionOf(_ reply: PhoneMessage) -> SessionId? {
    guard case .session(_, _, let session, _) = snapshotOf(reply) else { return nil }
    return session.id
}

/// Watch が画面に出しているセッション `session` で `kind` を頼む
private func operate(_ kind: SessionOperationKind, _ session: SessionId?, id: SessionEventId = eventId())
    -> WatchMessage
{
    .operate(id: id, kind: kind, session: session!, recordStore: store)
}

@Test("Watch で開始すると iPhone の記録先でセッションが始まり、始まったスナップショットが Watch に返る")
func startFromWatch() async throws {
    let clock = TestClock()
    let backend = phoneBackend(clock)
    let reply = await replyTo(.start(id: eventId(), recordStore: store), using: backend, recordStore: store)
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
    let start = WatchMessage.start(id: eventId(), recordStore: store)
    let first = await replyTo(start, using: backend, recordStore: store)
    clock.advance(minutes: 1)
    let retried = await replyTo(start, using: backend, recordStore: store)
    #expect(sessionOf(first) != nil)
    #expect(sessionOf(first) == sessionOf(retried))
}

/// 開始して1分ごとに `kinds` の操作を1つずつ行ったあとの状態を、Watch から頼んだときと iPhone で行ったときとで返す
private func statesAfter(_ kinds: [SessionOperationKind]) async throws -> (throughWatch: TimerState?, onPhone: TimerState?) {
    let watchClock = TestClock()
    let throughWatch = phoneBackend(watchClock)
    var reply = await replyTo(.start(id: eventId(), recordStore: store), using: throughWatch, recordStore: store)
    let session = sessionOf(reply)
    let phoneClock = TestClock()
    let onPhone = phoneBackend(phoneClock)
    var phoneSnapshot = try await onPhone.startSession(id: eventId()).get()
    for kind in kinds {
        watchClock.advance(minutes: 1)
        phoneClock.advance(minutes: 1)
        reply = await replyTo(operate(kind, session), using: throughWatch, recordStore: store)
        phoneSnapshot = try await onPhone.operateSession(id: eventId(), kind: kind).get()
    }
    guard case .session(_, _, _, let phoneState) = phoneSnapshot else { return (stateOf(reply), nil) }
    return (stateOf(reply), phoneState)
}

@Test("Watch で一時停止すると、iPhone で一時停止したのと同じく集中の残り時間が止まる")
func pauseFromWatchMatchesPhone() async throws {
    let states = try await statesAfter([.pause])
    guard case .focus(let focus) = states.throughWatch, case .paused = focus.clock else {
        Issue.record("集中が一時停止していない: \(String(describing: states.throughWatch))")
        return
    }
    #expect(focus.remainingSeconds == 6 * 60)
    #expect(states.throughWatch == states.onPhone)
}

@Test("Watch で再開すると、iPhone で再開したのと同じく止めたところから集中が進む")
func resumeFromWatchMatchesPhone() async throws {
    let states = try await statesAfter([.pause, .resume])
    guard case .focus(let focus) = states.throughWatch, case .running = focus.clock else {
        Issue.record("集中が進んでいない: \(String(describing: states.throughWatch))")
        return
    }
    #expect(focus.remainingSeconds == 6 * 60)
    #expect(states.throughWatch == states.onPhone)
}

@Test("Watch で中断すると、iPhone で中断したのと同じく不成立セットになり待機に戻る")
func abortFromWatchMatchesPhone() async throws {
    let states = try await statesAfter([.abort])
    guard case .idle(let idle) = states.throughWatch else {
        Issue.record("待機になっていない: \(String(describing: states.throughWatch))")
        return
    }
    #expect(idle.setNumber == 1 && idle.completedSets == 0)
    #expect(states.throughWatch == states.onPhone)
}

@Test("Watch で終了すると、iPhone で終了したのと同じくセッションが閉じる")
func endFromWatchMatchesPhone() async throws {
    let states = try await statesAfter([.end])
    guard case .ended = states.throughWatch else {
        Issue.record("終了していない: \(String(describing: states.throughWatch))")
        return
    }
    #expect(states.throughWatch == states.onPhone)
}

@Test("届いたか確かめられずに Watch が同じ ID で同じ操作を頼み直しても、操作は1回だけ記録される")
func operationRetriedWithSameId() async throws {
    let clock = TestClock()
    let backend = phoneBackend(clock)
    let session = sessionOf(await replyTo(.start(id: eventId(), recordStore: store), using: backend, recordStore: store))
    clock.advance(minutes: 1)
    let pause = operate(.pause, session)
    let first = await replyTo(pause, using: backend, recordStore: store)
    clock.advance(minutes: 1)
    let retried = await replyTo(pause, using: backend, recordStore: store)
    guard case .session(_, _, let recorded, _) = snapshotOf(retried) else {
        Issue.record("頼み直したらセッションが返らない: \(retried)")
        return
    }
    #expect(recorded.events.operations.count == 1)
    #expect(stateOf(retried) == stateOf(first))
}

@Test("終了の答えが Watch に返らず、同じ ID で頼み直したら、終了したスナップショットが返り、記録は変わらない")
func endRetriedWithSameIdAfterSessionClosed() async throws {
    let clock = TestClock()
    let backend = phoneBackend(clock)
    let session = sessionOf(await replyTo(.start(id: eventId(), recordStore: store), using: backend, recordStore: store))
    clock.advance(minutes: 1)
    let end = operate(.end, session)
    let first = await replyTo(end, using: backend, recordStore: store)
    let before = try await backend.getCurrentSession().get()
    clock.advance(minutes: 1)
    let retried = await replyTo(end, using: backend, recordStore: store)
    guard case .ended = stateOf(retried) else {
        Issue.record("頼み直したら終了したスナップショットが返らない: \(retried)")
        return
    }
    #expect(stateOf(retried) == stateOf(first))
    #expect(try await backend.getCurrentSession().get().revision == before.revision)
}

@Test("Watch が同じ ID で別の操作を頼むと、断られた文言が返り、記録は変わらない")
func sameIdForAnotherOperationIsRefused() async throws {
    let clock = TestClock()
    let backend = phoneBackend(clock)
    let session = sessionOf(await replyTo(.start(id: eventId(), recordStore: store), using: backend, recordStore: store))
    let id = eventId()
    clock.advance(minutes: 1)
    _ = await replyTo(operate(.pause, session, id: id), using: backend, recordStore: store)
    let before = try await backend.getCurrentSession().get()
    clock.advance(minutes: 1)
    let reply = await replyTo(operate(.end, session, id: id), using: backend, recordStore: store)
    #expect(reply == .refused(message: "操作できませんでした。最新の状態を読み込み直しました。"))
    #expect(try await backend.getCurrentSession().get().revision == before.revision)
}

@Test(
    "いまできない操作（ジャーナル中の中断・一時停止中の一時停止・進んでいるときの再開・終了したあとの終了）を Watch が頼むと、断られた文言が返り、記録は変わらない",
    arguments: [
        ([], 7 * 60 + 30, SessionOperationKind.abort),
        ([.pause], 2 * 60, .pause),
        ([], 60, .resume),
        ([.end], 2 * 60, .end),
    ] as [([SessionOperationKind], Int64, SessionOperationKind)])
func unavailableOperationIsRefused(before kinds: [SessionOperationKind], at seconds: Int64, kind: SessionOperationKind)
    async throws
{
    let clock = TestClock()
    let backend = phoneBackend(clock)
    let session = sessionOf(await replyTo(.start(id: eventId(), recordStore: store), using: backend, recordStore: store))
    for done in kinds {
        clock.advance(minutes: 1)
        _ = await replyTo(operate(done, session), using: backend, recordStore: store)
    }
    clock.advance(seconds: seconds - Int64(kinds.count) * 60)
    let before = try await backend.getCurrentSession().get()
    let reply = await replyTo(operate(kind, session), using: backend, recordStore: store)
    #expect(reply == .refused(message: "操作できませんでした。最新の状態を読み込み直しました。"))
    #expect(try await backend.getCurrentSession().get().revision == before.revision)
}

@Test("Watch が古い表示のまま前のセッションを操作すると、iPhone のいまのセッションは変えず、表示が古いと断る")
func operationOnPreviousSessionIsRefused() async throws {
    let clock = TestClock()
    let backend = phoneBackend(clock)
    let previous = sessionOf(await replyTo(.start(id: eventId(), recordStore: store), using: backend, recordStore: store))
    clock.advance(minutes: 1)
    _ = try await backend.operateSession(id: eventId(), kind: .end).get()
    // Watch に届かないあいだに、iPhone で次のセッションを始めた
    _ = try await backend.startSession(id: eventId()).get()
    let before = try await backend.getCurrentSession().get()
    clock.advance(minutes: 1)
    for kind in [SessionOperationKind.pause, .end] {
        #expect(await replyTo(operate(kind, previous), using: backend, recordStore: store)
            == .refused(message: watchOutdatedMessage))
    }
    #expect(try await backend.getCurrentSession().get().revision == before.revision)
}

@Test("Watch が前の記録先を出したまま開始・操作すると、iPhone のいまの記録先は変えず、表示が古いと断る")
func requestForPreviousRecordStoreIsRefused() async throws {
    let backend = phoneBackend(TestClock())
    let session = sessionOf(await replyTo(.start(id: eventId(), recordStore: store), using: backend, recordStore: store))
    let before = try await backend.getCurrentSession().get()
    let previousStore = RecordStoreTag("signed-out")
    let requests: [WatchMessage] = [
        .start(id: eventId(), recordStore: previousStore),
        .operate(id: eventId(), kind: .end, session: session!, recordStore: previousStore),
    ]
    for request in requests {
        #expect(await replyTo(request, using: backend, recordStore: store) == .refused(message: watchOutdatedMessage))
    }
    #expect(try await backend.getCurrentSession().get() == before)
}

@Test("Watch で終了すると、iPhone は Watch に答える前に終了したスナップショットを画面に渡し、その先の通知を予約しない")
@MainActor
func answeredSnapshotReachesPhoneBeforeReply() async throws {
    let clock = TestClock()
    let backend = phoneBackend(clock)
    var handed: [PhoneSnapshot] = []
    let started = await answerWatch(
        .start(id: eventId(), recordStore: store), recordStore: { (backend, store) }, answered: { handed.append($0) })
    clock.advance(minutes: 1)
    let ended = await answerWatch(
        operate(.end, sessionOf(started)), recordStore: { (backend, store) }, answered: { handed.append($0) })

    // 答えが返った時点で、画面にはもう渡し終えている
    guard case .snapshot(let startedAnswer) = started, case .snapshot(let endedAnswer) = ended else {
        Issue.record("スナップショットが返らない: \(started) / \(ended)")
        return
    }
    #expect(handed == [startedAnswer, endedAnswer])
    // 画面が開始したときのスナップショットのままだと、Watch が振動の範囲を閉じたときに、終えたセッションの通知を予約し直してしまう
    let now = clock.read()
    #expect(!phaseNotificationPlanOf(startedAnswer.received.snapshot, now: now, settings: .defaults, watch: .off).isEmpty)
    #expect(phaseNotificationPlanOf(endedAnswer.received.snapshot, now: now, settings: .defaults, watch: .off).isEmpty)
}

@Test("Watch の頼みに答えるあいだに iPhone が記録先を替えたら、替わった先の今の様子を画面に渡して答える")
@MainActor
func recordStoreSwitchedWhileAnswering() async throws {
    let device = phoneBackend(TestClock())
    let account = phoneBackend(TestClock())
    let accountStore = RecordStoreTag("account")
    _ = try await account.startSession(id: eventId()).get()
    var reads = 0
    var handed: [PhoneSnapshot] = []
    let answer = await answerWatch(
        .start(id: eventId(), recordStore: store),
        recordStore: {
            reads += 1
            return reads == 1 ? (device, store) : (account, accountStore)
        }, answered: { handed.append($0) })
    guard case .snapshot(let snapshot) = answer else {
        Issue.record("スナップショットが返らない: \(answer)")
        return
    }
    #expect(snapshot.recordStore == accountStore)
    #expect(snapshot.received.snapshot == (try await account.getCurrentSession().get()))
    #expect(handed == [snapshot])
}

/// 頼みの操作イベントの ID
private func eventIdOf(_ request: WatchRequest?) -> SessionEventId? {
    switch request?.message {
    case .start(let id, _)?, .operate(let id, _, _, _)?: id
    case .current?, .vibration?, nil: nil
    }
}

private func phoneSnapshotOf(_ reply: PhoneMessage) throws -> PhoneSnapshot {
    guard case .snapshot(let snapshot) = reply else { throw WatchLinkTestError.noSnapshot(reply) }
    return snapshot
}

private enum WatchLinkTestError: Error {
    case noSnapshot(PhoneMessage)
}

@Test("答えが返らなかった頼みを、同じ記録を見たまま押し直すと、同じ操作イベントの ID で送り直す。ほかの操作は新しい ID で送る")
func unansweredRequestIsResentWithSameId() async throws {
    let clock = TestClock()
    let backend = phoneBackend(clock)
    let shown = try phoneSnapshotOf(
        await replyTo(.start(id: eventId(), recordStore: store), using: backend, recordStore: store))
    let pause = try #require(WatchRequest.of(.operate(.pause), shown: shown, unanswered: nil, newEventId: eventId))
    // 記録されていなかったので、今の様子を頼み直すと、同じ変更の番号のスナップショットが届く（記録先の時刻は進んでいる）
    clock.advance(minutes: 1)
    let refreshed = try phoneSnapshotOf(await replyTo(.current, using: backend, recordStore: store))
    #expect(refreshed != shown)
    #expect(WatchRequest.of(.operate(.pause), shown: refreshed, unanswered: pause, newEventId: eventId) == pause)
    let end = WatchRequest.of(.operate(.end), shown: refreshed, unanswered: pause, newEventId: eventId)
    #expect(eventIdOf(end) != nil && eventIdOf(end) != eventIdOf(pause))
}

@Test("答えが返らなかった頼みが実は記録されていて、頼み直した今の様子で記録が進んでいたら、次の頼みは新しい ID で送る")
func requestAfterRecordedUnansweredUsesNewId() async throws {
    let clock = TestClock()
    let backend = phoneBackend(clock)
    let shown = try phoneSnapshotOf(
        await replyTo(.start(id: eventId(), recordStore: store), using: backend, recordStore: store))
    let pause = try #require(WatchRequest.of(.operate(.pause), shown: shown, unanswered: nil, newEventId: eventId))
    clock.advance(minutes: 1)
    // iPhone には届いて記録されたが、答えが Watch に返らなかった
    _ = await replyTo(pause.message, using: backend, recordStore: store)
    let refreshed = try phoneSnapshotOf(await replyTo(.current, using: backend, recordStore: store))
    let again = WatchRequest.of(.operate(.pause), shown: refreshed, unanswered: pause, newEventId: eventId)
    #expect(eventIdOf(again) != nil && eventIdOf(again) != eventIdOf(pause))
}

@Test("Watch の頼みには画面に出している記録先とセッションを添え、セッションがないのに操作を頼むことはない")
func requestCarriesShownSessionAndRecordStore() async throws {
    let backend = phoneBackend(TestClock())
    let empty = try phoneSnapshotOf(await replyTo(.current, using: backend, recordStore: store))
    #expect(WatchRequest.of(.operate(.end), shown: empty, unanswered: nil, newEventId: eventId) == nil)
    let start = WatchRequest.of(.start, shown: empty, unanswered: nil, newEventId: eventId)
    guard case .start(_, let startStore)? = start?.message else {
        Issue.record("開始の頼みにならない: \(String(describing: start))")
        return
    }
    #expect(startStore == store)
    let shown = try phoneSnapshotOf(await replyTo(start!.message, using: backend, recordStore: store))
    let end = WatchRequest.of(.operate(.end), shown: shown, unanswered: nil, newEventId: eventId)
    guard case .operate(_, .end, let session, let endStore)? = end?.message else {
        Issue.record("終了の頼みにならない: \(String(describing: end))")
        return
    }
    #expect(session == sessionOf(.snapshot(shown)) && endStore == store)
}

@Test("Watch が今の様子を頼むと、iPhone の記録先の今のスナップショットが返る")
func currentSnapshot() async throws {
    let backend = phoneBackend(TestClock())
    _ = try await backend.startSession(id: eventId()).get()
    let reply = await replyTo(.current, using: backend, recordStore: store)
    #expect(snapshotOf(reply) == (try await backend.getCurrentSession().get()))
}

@Test("Watch が振動で知らせる範囲を伝えると、記録先に通さずに受け取ったと答える")
func vibrationIsAcceptedWithoutTouchingRecords() async throws {
    let backend = phoneBackend(TestClock())
    let before = try await backend.getCurrentSession().get()
    let covering = ToldWatchVibration(vibration: .covering(before: t0), sequence: 1)
    #expect(await replyTo(.vibration(covering), using: backend, recordStore: store) == .accepted)
    #expect(await replyTo(.vibration(.none), using: backend, recordStore: store) == .accepted)
    #expect(try await backend.getCurrentSession().get() == before)
}

@Test("iPhone は Watch が伝えた番号で範囲の新旧を決め、先に伝えた範囲が閉じたあとに届いたら捨てる")
func laterToldVibrationWins() {
    let covering = ToldWatchVibration(vibration: .covering(before: t0.adding(milliseconds: 900_000)), sequence: 10)
    let closed = ToldWatchVibration(vibration: .off, sequence: 11)
    #expect(ToldWatchVibration.none.applying(covering) == covering)
    #expect(covering.applying(closed) == closed)
    // 範囲を伸ばす頼みが、閉じる頼みより遅れて届いた
    #expect(closed.applying(covering) == nil)
    // 届いたか確かめられずに送り直した同じ頼み
    #expect(closed.applying(closed) == closed)
}

@Test("Watch が伝える番号は、前の番号より大きく、時計が戻っても前より小さくならない")
func sequenceOnlyGrows() {
    #expect(nextWatchVibrationSequence(after: 0, deviceNow: t0) == t0.milliseconds)
    #expect(nextWatchVibrationSequence(after: t0.milliseconds, deviceNow: t0) == t0.milliseconds + 1)
    // 時計が1秒戻った
    #expect(
        nextWatchVibrationSequence(after: t0.milliseconds + 5, deviceNow: t0.adding(milliseconds: -1000))
            == t0.milliseconds + 6)
}

@Test("頼みと答えは送る形にして戻しても同じ")
func codingRoundTrip() async throws {
    let backend = phoneBackend(TestClock())
    let reply = await replyTo(.start(id: eventId(), recordStore: store), using: backend, recordStore: store)
    let session = try #require(sessionOf(reply))
    let messages: [WatchMessage] =
        [
            .current, .start(id: eventId(), recordStore: store), .vibration(.none),
            .vibration(ToldWatchVibration(vibration: .covering(before: t0), sequence: 1)),
        ]
        + SessionOperationKind.allCases.map { .operate(id: eventId(), kind: $0, session: session, recordStore: store) }
    for message in messages {
        #expect(WatchLinkCoding.decode(WatchMessage.self, from: WatchLinkCoding.encode(message)) == message)
    }
    let replies: [PhoneMessage] = [reply, .refused(message: "操作できませんでした。"), .accepted]
    for reply in replies {
        #expect(WatchLinkCoding.decode(PhoneMessage.self, from: WatchLinkCoding.encode(reply)) == reply)
    }
    #expect(WatchLinkCoding.decode(WatchMessage.self, from: Data("{}".utf8)) == nil)
}

private func phoneSnapshot(revision: Int, serverTime: Instant = t0, store: RecordStoreTag) -> PhoneSnapshot {
    PhoneSnapshot(
        received: Received(
            snapshot: .noSession(serverTime: serverTime, revision: Revision(revision)!),
            offset: ClockOffset(serverAheadMs: 0)),
        recordStore: store)
}

@Test("同じ記録先のスナップショットは、手元より古いものが後から届いても捨てる")
func olderSnapshotFromSameStoreIsDropped() {
    let newer = phoneSnapshot(revision: 5, store: store)
    let loading = PhoneSnapshotLoading.waiting.applying(newer).applying(phoneSnapshot(revision: 4, store: store))
    #expect(loading == .loaded(newer))
}

@Test("iPhone がログイン・ログアウトで記録先を替えたら、変更の番号が小さくても新しい記録先のスナップショットに置き換える")
func snapshotFromAnotherStoreReplaces() {
    let account = phoneSnapshot(revision: 2, store: RecordStoreTag("account"))
    let loading = PhoneSnapshotLoading.waiting.applying(phoneSnapshot(revision: 40, store: store)).applying(account)
    #expect(loading == .loaded(account))
}
