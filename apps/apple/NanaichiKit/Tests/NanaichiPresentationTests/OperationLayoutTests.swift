import NanaichiDomain
import Testing

@testable import NanaichiPresentation

private func layout(_ session: Session, at now: Instant) -> [OperationButton] {
    operationButtonsOf(session.availableOperations(at: now))
}

@Test("集中中は一時停止を主にし、中断を控えめに、終了を文字だけで最後に置く")
func focusLayout() {
    #expect(
        layout(started(), at: minutes(1)) == [
            OperationButton(kind: .pause, emphasis: .primary), OperationButton(kind: .abort, emphasis: .secondary),
            OperationButton(kind: .end, emphasis: .quiet),
        ])
}

@Test("休憩中は休憩スキップを主にして先頭に出し、一時停止は控えめにする")
func breakLayout() {
    #expect(
        layout(started(), at: minutes(25)) == [
            OperationButton(kind: .skipBreak, emphasis: .primary), OperationButton(kind: .pause, emphasis: .secondary),
            OperationButton(kind: .end, emphasis: .quiet),
        ])
}

@Test("一時停止中は再開を主にする")
func pausedLayout() throws {
    let paused = try operated(started(), .pause, at: minutes(1))
    #expect(layout(paused, at: minutes(2)).first == OperationButton(kind: .resume, emphasis: .primary))
}

@Test("切り替え待ちでは進めるを主にし、休憩スキップもできるときは控えめにする")
func awaitingLayout() {
    let manualToBreak = AdvanceMode(
        focusToJournal: .auto, journalToFocus: .auto, journalToBreak: .manual, breakToFocus: .auto)
    #expect(
        layout(started(mode: manualToBreak), at: minutes(25)) == [
            OperationButton(kind: .advance, emphasis: .primary),
            OperationButton(kind: .skipBreak, emphasis: .secondary), OperationButton(kind: .end, emphasis: .quiet),
        ])
}

@Test("中断のあとの待機では集中の再開始を主にする")
func idleLayout() throws {
    let idle = try operated(started(), .abort, at: minutes(1))
    #expect(
        layout(idle, at: minutes(2)) == [
            OperationButton(kind: .restartFocus, emphasis: .primary), OperationButton(kind: .end, emphasis: .quiet),
        ])
}

@Test("開始と再開は ▶、一時停止は ⏸、中断は ×、終了は電源の記号を出す")
func decidedSymbols() {
    #expect(startSymbol == "play.fill")
    #expect(operationSymbolOf(.resume) == "play.fill")
    #expect(operationSymbolOf(.pause) == "pause.fill")
    #expect(operationSymbolOf(.abort) == "xmark")
    #expect(operationSymbolOf(.end) == "power")
}

@Test("集中・一時停止中・ジャーナル・休憩・待機・切り替え待ちのどれでも、並ぶ操作のアイコンが重ならない")
func symbolsDifferWithinState() throws {
    let manualToBreak = AdvanceMode(
        focusToJournal: .auto, journalToFocus: .auto, journalToBreak: .manual, breakToFocus: .auto)
    let scenes: [(String, Session, Instant)] = [
        ("集中", started(), minutes(1)),
        ("一時停止中", try operated(started(), .pause, at: minutes(1)), minutes(2)),
        ("ジャーナル", started(), minutes(7, 30)),
        ("休憩", started(), minutes(25)),
        ("待機", try operated(started(), .abort, at: minutes(1)), minutes(2)),
        ("ジャーナルの前の切り替え待ち", started(mode: manualToJournal), minutes(7, 30)),
        ("休憩の前の切り替え待ち", started(mode: manualToBreak), minutes(25)),
    ]
    for (name, session, now) in scenes {
        let symbols = layout(session, at: now).map { operationSymbolOf($0.kind) }
        #expect(Set(symbols).count == symbols.count, "\(name)でアイコンが重なる: \(symbols)")
    }
}
