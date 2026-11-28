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

/// セッション中の Watch の画面に並ぶ操作
private func watchOperationsOf(_ face: WatchFace) -> [SessionOperationKind]? {
    guard case .inSession(_, let operations, _) = face.screen else { return nil }
    return operations.map(\.kind)
}

@Test("集中中は Watch で一時停止・中断・終了ができ、iPhone の応答を待つあいだは押せない")
func watchOperationsDuringFocus() {
    let face = WatchFace.of(viewOf(started(), at: minutes(1)), reach: .reachable, pending: false)
    guard case .inSession(.focus(let focus), let operations, let control) = face.screen else {
        Issue.record("集中になっていない: \(face)")
        return
    }
    #expect(focus.remainingSeconds == 6 * 60)
    #expect(operations.map(\.kind) == [.pause, .abort, .end])
    #expect(control == .enabled)
    let pending = WatchFace.of(viewOf(started(), at: minutes(1)), reach: .reachable, pending: true)
    guard case .inSession(.focus, _, let pendingControl) = pending.screen else {
        Issue.record("応答を待つあいだに集中の画面でなくなった: \(pending)")
        return
    }
    #expect(pendingControl == .pending)
    #expect(WatchControl.pending.isEnabled == false)
}

@Test("一時停止中の集中は Watch で再開・中断・終了ができる")
func watchOperationsWhilePaused() throws {
    let paused = try operated(started(), .pause, at: minutes(1))
    let face = WatchFace.of(viewOf(paused, at: minutes(2)), reach: .reachable, pending: false)
    #expect(watchOperationsOf(face) == [.resume, .abort, .end])
}

@Test("ジャーナル中は中断できないので Watch に中断を出さず、iPhone に届かなければ押せず、それを出す")
func watchNoAbortDuringJournal() {
    let face = WatchFace.of(viewOf(started(), at: minutes(7, 30)), reach: .unreachable, pending: false)
    guard case .inSession(.journal, let operations, let control) = face.screen else {
        Issue.record("ジャーナルになっていない: \(face)")
        return
    }
    #expect(operations.map(\.kind) == [.pause, .end])
    #expect(control == .phoneUnreachable)
    #expect(face.phoneUnreachableNotice != nil)
}

@Test("休憩中の休憩スキップは iPhone で行い、Watch には一時停止と終了だけを出す")
func watchOperationsDuringBreak() {
    let face = WatchFace.of(viewOf(started(), at: minutes(25)), reach: .reachable, pending: false)
    #expect(watchOperationsOf(face) == [.pause, .end])
}

@Test("一時停止中のジャーナルと休憩は、Watch で再開と終了ができる。休憩スキップは iPhone で行う")
func watchOperationsWhilePausedInJournalOrBreak() throws {
    let journal = try operated(started(), .pause, at: minutes(7, 30))
    #expect(
        watchOperationsOf(WatchFace.of(viewOf(journal, at: minutes(7, 40)), reach: .reachable, pending: false))
            == [.resume, .end])
    let breakTime = try operated(started(), .pause, at: minutes(25))
    #expect(
        watchOperationsOf(WatchFace.of(viewOf(breakTime, at: minutes(26)), reach: .reachable, pending: false))
            == [.resume, .end])
}

@Test("待機からの集中の再開始と、切り替え待ちから進めるのは iPhone で行い、Watch には終了だけを出す")
func watchOnlyEndsWhenIdleOrAwaiting() throws {
    let idle = try operated(started(), .abort, at: minutes(1))
    #expect(watchOperationsOf(WatchFace.of(viewOf(idle, at: minutes(2)), reach: .reachable, pending: false)) == [.end])
    let awaiting = WatchFace.of(viewOf(started(mode: manualToJournal), at: minutes(7, 30)), reach: .reachable, pending: false)
    #expect(watchOperationsOf(awaiting) == [.end])
}
