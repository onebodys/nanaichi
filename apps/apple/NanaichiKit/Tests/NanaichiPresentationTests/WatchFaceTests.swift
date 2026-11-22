import NanaichiDomain
import Testing

@testable import NanaichiPresentation

private func viewOf(_ session: Session, at now: Instant) -> TimerView {
    .of(.loaded(received(session, at: now)), deviceNow: now)
}

private let noSession = TimerView.of(
    .loaded(Received(snapshot: .noSession(serverTime: t0, revision: .initial), offset: ClockOffset(serverAheadMs: 0))),
    deviceNow: t0)

@Test("Watch は iPhone からスナップショットが届くまで待つ")
func watchWaitsForPhone() {
    let face = WatchFace.of(.loading, reach: .reachable, pending: false)
    #expect(face.screen == .waitingForPhone)
    #expect(face.phoneUnreachableNotice == nil)
}

@Test("セッションの外では開始でき、iPhone に届かなければ開始を押せず、届かないことを出す")
func watchStartNeedsPhone() {
    #expect(WatchFace.of(noSession, reach: .reachable, pending: false).screen == .outOfSession(start: .enabled))
    let unreachable = WatchFace.of(noSession, reach: .unreachable, pending: false)
    #expect(unreachable.screen == .outOfSession(start: .phoneUnreachable))
    #expect(unreachable.phoneUnreachableNotice == "iPhone に繋がっていません")
}

@Test("終了したあとも Watch から次のセッションを開始できる")
func watchStartAfterEnded() throws {
    let ended = try operated(started(), .end, at: minutes(3))
    #expect(WatchFace.of(viewOf(ended, at: minutes(4)), reach: .reachable, pending: false).screen
        == .outOfSession(start: .enabled))
}

@Test("集中中は Watch で中断でき、iPhone の応答を待つあいだは押せない")
func watchAbortDuringFocus() {
    let face = WatchFace.of(viewOf(started(), at: minutes(1)), reach: .reachable, pending: false)
    guard case .inSession(.focus(let focus), let abort) = face.screen else {
        Issue.record("集中になっていない: \(face)")
        return
    }
    #expect(focus.remainingSeconds == 6 * 60)
    #expect(abort == .enabled)
    let pending = WatchFace.of(viewOf(started(), at: minutes(1)), reach: .reachable, pending: true)
    guard case .inSession(_, let pendingAbort) = pending.screen else { return }
    #expect(pendingAbort == .pending)
    #expect(pendingAbort?.isEnabled == false)
}

@Test("ジャーナル中は中断できないので Watch に中断を出さず、iPhone に届かなければそれを出す")
func watchNoAbortDuringJournal() {
    let face = WatchFace.of(viewOf(started(), at: minutes(7, 30)), reach: .unreachable, pending: false)
    guard case .inSession(.journal, let abort) = face.screen else {
        Issue.record("ジャーナルになっていない: \(face)")
        return
    }
    #expect(abort == nil)
    #expect(face.phoneUnreachableNotice != nil)
}
