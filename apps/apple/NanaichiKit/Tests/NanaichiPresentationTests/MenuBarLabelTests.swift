import NanaichiDomain
import Testing

@testable import NanaichiPresentation

private func labelAt(_ session: Session, _ now: Instant) -> MenuBarLabel {
    menuBarLabelOf(TimerView.of(.loaded(received(session, at: t0)), deviceNow: now))
}

@Test("セッションの外では、メニューバーに記号だけを出す")
func menuBarLabelOutOfSession() throws {
    #expect(menuBarLabelOf(.loading) == .symbolOnly(.outOfSession, spoken: "nanaichi"))
    #expect(menuBarLabelOf(.noSession) == .symbolOnly(.outOfSession, spoken: "nanaichi"))
    let ended = try operated(started(), .end, at: minutes(3))
    #expect(labelAt(ended, minutes(4)) == .symbolOnly(.outOfSession, spoken: "nanaichi"))
}

@Test("集中中は、集中の記号と残り時間を出す")
func menuBarLabelFocus() {
    #expect(labelAt(started(), minutes(0, 1)) == .countdown(.phase(.focus), text: "6:59", spoken: "集中 残り 6分 59秒"))
}

@Test("ジャーナルと休憩も、そのフェーズの記号と残り時間を出す")
func menuBarLabelJournalAndBreak() {
    #expect(labelAt(started(), minutes(7, 15)).symbol == .phase(.journal))
    #expect(labelAt(started(), minutes(7, 15)) == .countdown(.phase(.journal), text: "0:45", spoken: "ジャーナル 残り 45秒"))
    #expect(labelAt(started(), minutes(25)).symbol == .phase(.breakTime))
}

@Test("一時停止中は、一時停止の記号と止めたときの残り時間を出す")
func menuBarLabelPaused() throws {
    let paused = try operated(started(), .pause, at: minutes(2))
    #expect(labelAt(paused, minutes(4)) == .countdown(.paused, text: "5:00", spoken: "集中 一時停止中 残り 5分 0秒"))
}

@Test("待機中は、時計が進まないので記号だけを出す")
func menuBarLabelIdle() throws {
    let idle = try operated(started(), .abort, at: minutes(2))
    #expect(labelAt(idle, minutes(3)) == .symbolOnly(.idle, spoken: "nanaichi 待機"))
}

@Test("切り替え待ちは、これから始まるフェーズの記号と 0:00 を出す")
func menuBarLabelAwaitingAdvance() {
    #expect(
        labelAt(started(mode: manualToJournal), minutes(8))
            == .countdown(.phase(.journal), text: "0:00", spoken: "集中が終わりました"))
}
