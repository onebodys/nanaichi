import Foundation
import Testing

@testable import NanaichiDomain

private let t0 = Instant(milliseconds: 1_793_610_000_000)

private func minutes(_ value: Int64, _ seconds: Int64 = 0) -> Instant {
    t0.adding(milliseconds: value * 60_000 + seconds * 1000)
}

private func newEventId() -> SessionEventId { SessionEventId(UUID().uuidString.lowercased())! }

private func started(mode: AdvanceMode = .allAuto) -> Session {
    Session.start(
        id: SessionId(UUID().uuidString.lowercased())!, startEventId: newEventId(), now: t0,
        advanceModeChanges: [AdvanceModeChange(at: t0.adding(milliseconds: -1), mode: mode)])
}

private func operated(_ session: Session, _ kind: SessionOperationKind, at: Instant) throws -> Session {
    try session.operate(RecordedSessionEvent(id: newEventId(), event: SessionOperation(kind: kind, at: at))).get()
        .session
}

@Test("集中中なら、ジャーナル・集中と続く切り替わりを時刻の順に返す")
func upcomingChangesFollowTheRound() {
    let changes = started().upcomingPhaseChanges(after: minutes(2), limit: 7)
    #expect(
        changes == [
            UpcomingPhaseChange(at: minutes(7), to: .journal(round: 1, setNumber: 1)),
            UpcomingPhaseChange(at: minutes(8), to: .focus(round: 1, setNumber: 2)),
            UpcomingPhaseChange(at: minutes(15), to: .journal(round: 1, setNumber: 2)),
            UpcomingPhaseChange(at: minutes(16), to: .focus(round: 1, setNumber: 3)),
            UpcomingPhaseChange(at: minutes(23), to: .journal(round: 1, setNumber: 3)),
            UpcomingPhaseChange(at: minutes(24), to: .breakTime(round: 1)),
            UpcomingPhaseChange(at: minutes(29), to: .focus(round: 2, setNumber: 1)),
        ])
}

@Test("過ぎた切り替わりは返さない")
func pastChangesAreNotUpcoming() {
    let changes = started().upcomingPhaseChanges(after: minutes(7, 30), limit: 1)
    #expect(changes == [UpcomingPhaseChange(at: minutes(8), to: .focus(round: 1, setNumber: 2))])
}

@Test("記入も操作もなければ、自動終了の時刻より後の切り替わりは来ない")
func noChangesAfterAutoEnd() {
    let changes = started().upcomingPhaseChanges(after: t0, limit: 100)
    // 2ラウンド分（58分）で自動終了する。2ラウンド目の休憩のあとの集中（58分）は来ない
    #expect(changes.count == 13)
    #expect(changes.last == UpcomingPhaseChange(at: minutes(53), to: .breakTime(round: 2)))
}

@Test("一時停止中は、再開するまで切り替わりが来ない")
func noChangesWhilePaused() throws {
    let paused = try operated(started(), .pause, at: minutes(3))
    #expect(paused.upcomingPhaseChanges(after: minutes(4), limit: 10) == [])
}

@Test("再開すると、止めていた分だけ後ろにずれた時刻で切り替わる")
func resumedChangesShiftByPausedTime() throws {
    let resumed = try operated(try operated(started(), .pause, at: minutes(3)), .resume, at: minutes(5))
    #expect(
        resumed.upcomingPhaseChanges(after: minutes(5), limit: 1) == [
            UpcomingPhaseChange(at: minutes(9), to: .journal(round: 1, setNumber: 1))
        ])
}

@Test("待機中（中断のあと）は、集中を再開始するまで切り替わりが来ない")
func noChangesWhileIdle() throws {
    let idle = try operated(started(), .abort, at: minutes(3))
    #expect(idle.upcomingPhaseChanges(after: minutes(3), limit: 10) == [])
}

@Test("手動の切り替わりでは、切り替え待ちになる時刻に移る先のフェーズとして1件だけ返し、その先は返さない")
func manualAdvanceStopsAtAwaiting() {
    let manual = AdvanceMode(focusToJournal: .manual, journalToFocus: .auto, journalToBreak: .auto, breakToFocus: .auto)
    #expect(
        started(mode: manual).upcomingPhaseChanges(after: minutes(1), limit: 10) == [
            UpcomingPhaseChange(at: minutes(7), to: .journal(round: 1, setNumber: 1))
        ])
}

@Test("切り替え待ちのあいだは、進めるまで切り替わりが来ない")
func noChangesWhileAwaitingAdvance() {
    let manual = AdvanceMode(focusToJournal: .manual, journalToFocus: .auto, journalToBreak: .auto, breakToFocus: .auto)
    #expect(started(mode: manual).upcomingPhaseChanges(after: minutes(9), limit: 10) == [])
}

@Test("終了したセッションには切り替わりが来ない")
func noChangesAfterEnd() throws {
    let ended = try operated(started(), .end, at: minutes(3))
    #expect(ended.upcomingPhaseChanges(after: minutes(3), limit: 10) == [])
}

@Test("件数は limit までに抑える")
func limitCapsTheChanges() {
    #expect(started().upcomingPhaseChanges(after: t0, limit: 2).count == 2)
}
