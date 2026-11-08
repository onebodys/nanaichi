import NanaichiDomain
import Testing

@testable import NanaichiPresentation

@Test("残り時間を m:ss で出し、読み上げは分と秒で言う")
func countdownText() {
    #expect(countdownTextOf(remainingSeconds: 420) == "7:00")
    #expect(countdownTextOf(remainingSeconds: 65) == "1:05")
    #expect(countdownAccessibilityTextOf(remainingSeconds: 65) == "残り 1分 5秒")
    #expect(countdownAccessibilityTextOf(remainingSeconds: 9) == "残り 9秒")
}

@Test("次のフェーズを、集中ならセット番号かラウンドで、ジャーナルと休憩なら長さで言う")
func upcomingText() {
    #expect(upcomingTextOf(.journal(round: 1, setNumber: 1)) == "次は ジャーナル 1分")
    #expect(upcomingTextOf(.focus(round: 1, setNumber: 2)) == "次は 集中（2セット目）")
    #expect(upcomingTextOf(.breakTime(round: 1)) == "次は 休憩 5分")
    #expect(upcomingTextOf(.focus(round: 2, setNumber: 1)) == "次は 2ラウンド目の集中")
}

@Test("開始前に1セットの流れとラウンドの決まりを出す")
func rhythmText() {
    let rhythm = sessionRhythmOf()
    #expect(rhythm.focusSeconds == 420)
    #expect(rhythm.set == "集中 7分 → ジャーナル 1分")
    #expect(rhythm.round == "3セットごとに 5分の休憩が入ります")
}

@Test("休憩はラウンドだけ、切り替え待ちは終わったフェーズの位置を出す")
func positionText() throws {
    let session = started(mode: manualToJournal)
    #expect(positionTextOf(try #require(UnendedTimerState(session.stateAt(minutes(1))))) == "1ラウンド目・1セット目")
    #expect(positionTextOf(try #require(UnendedTimerState(session.stateAt(minutes(9))))) == "1ラウンド目・1セット目")
    let auto = started()
    #expect(positionTextOf(try #require(UnendedTimerState(auto.stateAt(minutes(25))))) == "1ラウンド目")
}

@Test("切り替え待ちの進めるボタンは、何が始まるかで言う")
func advanceButtonText() throws {
    let awaiting = try #require(UnendedTimerState(started(mode: manualToJournal).stateAt(minutes(9))))
    #expect(operationButtonTextOf(.advance, awaiting) == "ジャーナルを始める")
    #expect(operationButtonTextOf(.end, awaiting) == "終了")
}

@Test("切り替え待ちと一時停止は、止まってからの時間を1分未満なら秒だけで出す")
func agoTexts() {
    #expect(
        awaitingTextOf(finished: .focus(round: 1, setNumber: 1), since: minutes(7), now: minutes(9, 13))
            == "集中が終わりました · 2分13秒前")
    #expect(pausedForTextOf(pausedAt: minutes(3), now: minutes(3, 42)) == "止めてから 42秒")
    #expect(pausedForTextOf(pausedAt: minutes(3), now: minutes(5, 5)) == "止めてから 2分05秒")
}

@Test("このセッションの積み上げを、始めた時刻と完了セットと集中時間で出す")
func currentSessionText() {
    // t0 は 2026-11-02 18:00 (Asia/Tokyo)
    #expect(
        currentSessionTextOf(startedAt: t0, completedSets: 4, timeZone: tokyo)
            == "このセッション 18:00〜 · 完了 4セット · 集中 28分")
    #expect(sessionSpanTextOf(startedAt: t0, endedAt: minutes(102), timeZone: tokyo) == "18:00 〜 19:42")
}

@Test("集中時間は1時間に満たなければ分だけ、超えれば時間と分で出す")
func focusTimeText() {
    #expect(focusTimeTextOf(milliseconds: 42 * 60_000) == "42分")
    #expect(focusTimeTextOf(milliseconds: 70 * 60_000) == "1時間10分")
    #expect(todayFocusTextOf(.counted(completedSets: 10)) == TodayFocusText(focusTime: "1時間10分", sets: "10セット"))
    #expect(todayFocusTextOf(.unknown) == nil)
}

@Test("終了のしかたと不成立セットの有無で、まとめの文言を変える")
func endedTexts() {
    #expect(endedMessageOf(.end) == "セッションを終了しました")
    #expect(endedMessageOf(.autoEnd) == "記入も操作もないまま時間が過ぎたので、セッションを自動終了しました")
    #expect(abortedSetsNoteOf(0) == nil)
    #expect(abortedSetsNoteOf(2) == "点線は不成立セット（2セット）")
    #expect(entryCountTextOf(.notYetCounted) == "—")
}
