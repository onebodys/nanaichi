import NanaichiDomain
import Testing

@testable import NanaichiPresentation

@Test("集中中に、これからの切り替わりの時刻と文言で通知を予約する")
func planListsUpcomingChanges() {
    let session = started()
    let plan = phaseNotificationPlanOf(session.snapshot(at: minutes(1)), now: minutes(1), settings: .defaults)
    #expect(plan.count == 13)
    #expect(plan.map(\.at).prefix(3) == [minutes(7), minutes(8), minutes(15)])
    #expect(plan[0].title == "ジャーナルの時間です")
    #expect(plan[0].body == "1ラウンド目・1セット目の振り返りと、次にやることの整理")
    #expect(plan[1].title == "集中の時間です")
    #expect(plan[1].body == "1ラウンド目・2セット目の集中を始めます")
    #expect(plan[5].title == "休憩の時間です")
    #expect(plan[5].body == "1ラウンド目が終わりました")
    #expect(Set(plan.map(\.identifier)).count == plan.count)
    #expect(plan.allSatisfy { $0.identifier.hasPrefix(phaseNotificationIdentifierPrefix) })
}

@Test("手動の切り替わりでは、切り替え待ちになるときの1件だけを予約して止める")
func planStopsAtManualAdvance() {
    let plan = phaseNotificationPlanOf(
        started(mode: manualToJournal).snapshot(at: t0), now: minutes(1), settings: .defaults)
    #expect(plan.map(\.at) == [minutes(7)])
    #expect(plan.map(\.title) == ["ジャーナルの時間です"])
}

@Test("進めたあとは、進めた時刻から数えて次の切り替え待ちまでを予約し直す")
func planAfterAdvanceRestartsFromTheAdvance() throws {
    let advanced = try operated(started(mode: manualToJournal), .advance, at: minutes(9))
    let plan = phaseNotificationPlanOf(advanced.snapshot(at: minutes(9)), now: minutes(9), settings: .defaults)
    #expect(plan.map(\.at) == [minutes(10), minutes(17)])
    #expect(plan.map(\.to) == [.focus(round: 1, setNumber: 2), .journal(round: 1, setNumber: 2)])
}

@Test("一時停止中・セッションなし・通知を出さない設定では予約しない")
func planIsEmptyWhenNothingWillChange() throws {
    let paused = try operated(started(), .pause, at: minutes(2))
    #expect(phaseNotificationPlanOf(paused.snapshot(at: minutes(2)), now: minutes(2), settings: .defaults) == [])
    #expect(phaseNotificationPlanOf(.noSession(serverTime: t0), now: t0, settings: .defaults) == [])
    var silent = AlertSettings.defaults
    silent.notification = false
    #expect(phaseNotificationPlanOf(started().snapshot(at: t0), now: t0, settings: silent) == [])
}
