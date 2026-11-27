import NanaichiDomain
import Testing

@testable import NanaichiPresentation

// Watch がフェーズの切り替わりを振動で知らせる範囲と、iPhone の通知の分け方（Issue #73、ADR 0033）

@Test("Watch が振動で知らせる範囲の切り替わりは、iPhone の通知に予約しない")
func planLeavesCoveredChangesToWatch() {
    let snapshot = started().snapshot(at: minutes(1), revision: .initial)
    let plan = phaseNotificationPlanOf(
        snapshot, now: minutes(1), settings: .defaults, watch: .covering(before: minutes(15)))
    #expect(plan.map(\.at).prefix(2) == [minutes(15), minutes(16)])
    #expect(plan.count == 11)
}

@Test("範囲の終わりちょうどの切り替わりは、iPhone の通知が知らせる")
func rangeEndIsNotCovered() {
    #expect(WatchVibration.covering(before: minutes(7)).covers(minutes(6, 59)))
    #expect(!WatchVibration.covering(before: minutes(7)).covers(minutes(7)))
    #expect(!WatchVibration.off.covers(minutes(7)))
}

/// Watch を `step` 秒ごとに刻み、振動した時刻と移った先を集める
private func vibrations(
    _ snapshot: SessionSnapshot, from: Instant, to: Instant, step: Int64 = 1, within vibration: WatchVibration
) -> [UpcomingPhaseChange] {
    var watch = PhaseChangeVibration()
    var played: [UpcomingPhaseChange] = []
    var now = from
    while now <= to {
        if let phase = watch.observe(snapshot, now: now, within: vibration) {
            played.append(UpcomingPhaseChange(at: now, to: phase))
        }
        now = now.adding(milliseconds: step * 1000)
    }
    return played
}

@Test("1ラウンドの切り替わりは、範囲の中は Watch の振動だけ、外は iPhone の通知だけで、どれも1回ずつ知らせる")
func eachChangeIsAlertedOnce() {
    let snapshot = started().snapshot(at: minutes(1), revision: .initial)
    let vibration = WatchVibration.covering(before: minutes(20))
    let vibrated = vibrations(snapshot, from: minutes(1), to: minutes(35), within: vibration)
    let notified = phaseNotificationPlanOf(snapshot, now: minutes(1), settings: .defaults, watch: vibration)
        .filter { $0.at <= minutes(35) }
    // 7・8・15・16分の切り替わりは Watch、それより先（23分のジャーナル・24分の休憩・29分の集中）は iPhone
    #expect(vibrated.map(\.at) == [minutes(7), minutes(8), minutes(15), minutes(16)])
    #expect(
        vibrated.map(\.to) == [
            .journal(round: 1, setNumber: 1), .focus(round: 1, setNumber: 2), .journal(round: 1, setNumber: 2),
            .focus(round: 1, setNumber: 3),
        ])
    #expect(notified.map(\.at) == [minutes(23), minutes(24), minutes(29)])
    let all = started().upcomingPhaseChanges(after: minutes(1), limit: 64).filter { $0.at <= minutes(35) }
    #expect(Set(vibrated.map(\.at)).isDisjoint(with: notified.map(\.at)))
    #expect((vibrated.map(\.at) + notified.map(\.at)).sorted() == all.map(\.at))
}

@Test("刻みが遅れて切り替わりをいくつも過ぎたら、最後の1回だけ振動する")
func lateTickVibratesOnce() {
    let snapshot = started().snapshot(at: minutes(1), revision: .initial)
    var watch = PhaseChangeVibration()
    let vibration = WatchVibration.covering(before: minutes(30))
    #expect(watch.observe(snapshot, now: minutes(6), within: vibration) == nil)
    #expect(watch.observe(snapshot, now: minutes(9), within: vibration) == .focus(round: 1, setNumber: 2))
    #expect(watch.observe(snapshot, now: minutes(10), within: vibration) == nil)
}

@Test("範囲の外・スナップショットが替わった刻み・セッションの外では振動しない")
func noVibrationOutsideTheRange() throws {
    let session = started()
    let snapshot = session.snapshot(at: minutes(1), revision: .initial)
    #expect(vibrations(snapshot, from: minutes(6), to: minutes(9), within: .off).isEmpty)
    #expect(vibrations(snapshot, from: minutes(6), to: minutes(9), within: .covering(before: minutes(7))).isEmpty)

    // 集中の終わる前に中断して待機に移った（人の操作）。替わった刻みでは知らせない
    var watch = PhaseChangeVibration()
    let vibration = WatchVibration.covering(before: minutes(30))
    #expect(watch.observe(snapshot, now: minutes(6, 58), within: vibration) == nil)
    let aborted = try operated(session, .abort, at: minutes(6, 59)).snapshot(at: minutes(6, 59), revision: .initial)
    #expect(watch.observe(aborted, now: minutes(7, 1), within: vibration) == nil)
    #expect(watch.observe(aborted, now: minutes(20), within: vibration) == nil)

    let noSession = SessionSnapshot.noSession(serverTime: t0, revision: .initial)
    #expect(watch.observe(noSession, now: minutes(21), within: vibration) == nil)
    #expect(watch.observe(nil, now: minutes(22), within: vibration) == nil)
}

@Test("振動できるようになったら、15分先まで（振動できるのが終わる30秒前まで）を Watch が知らせると伝える")
func tellsCoveringWhenVibratable() {
    #expect(
        watchVibrationToTell(confirmed: .off, vibratableUntil: minutes(60), now: minutes(1))
            == .covering(before: minutes(16)))
    #expect(
        watchVibrationToTell(confirmed: .off, vibratableUntil: minutes(10), now: minutes(1))
            == .covering(before: minutes(9, 30)))
}

@Test("範囲の残りが10分を切ったら伸ばし、それまでは伝え直さない")
func renewsWhenRunningOut() {
    let confirmed = WatchVibration.covering(before: minutes(16))
    #expect(watchVibrationToTell(confirmed: confirmed, vibratableUntil: minutes(60), now: minutes(5)) == nil)
    #expect(
        watchVibrationToTell(confirmed: confirmed, vibratableUntil: minutes(60), now: minutes(6, 1))
            == .covering(before: minutes(21, 1)))
    // 期限が過ぎていても、振動できるなら伝え直す
    #expect(
        watchVibrationToTell(confirmed: confirmed, vibratableUntil: minutes(60), now: minutes(17))
            == .covering(before: minutes(32)))
}

@Test("振動できるのが終わる時刻で頭打ちの範囲は、伝え直さない")
func doesNotRepeatCappedRange() {
    let capped = WatchVibration.covering(before: minutes(9, 30))
    #expect(watchVibrationToTell(confirmed: capped, vibratableUntil: minutes(10), now: minutes(5)) == nil)
}

@Test("振動できるのが早く終わることになったら、範囲を縮める")
func shrinksWhenVibrationEndsEarlier() {
    #expect(
        watchVibrationToTell(confirmed: .covering(before: minutes(16)), vibratableUntil: minutes(8), now: minutes(5))
            == .covering(before: minutes(7, 30)))
}

@Test("振動できなくなったら範囲を閉じる。期限が過ぎていれば閉じなくてよい")
func closesWhenNoLongerVibratable() {
    #expect(watchVibrationToTell(confirmed: .covering(before: minutes(16)), vibratableUntil: nil, now: minutes(5)) == .off)
    #expect(
        watchVibrationToTell(confirmed: .covering(before: minutes(16)), vibratableUntil: minutes(5, 20), now: minutes(5))
            == .off)
    #expect(watchVibrationToTell(confirmed: .covering(before: minutes(16)), vibratableUntil: nil, now: minutes(16)) == nil)
    #expect(watchVibrationToTell(confirmed: .off, vibratableUntil: nil, now: minutes(5)) == nil)
}
