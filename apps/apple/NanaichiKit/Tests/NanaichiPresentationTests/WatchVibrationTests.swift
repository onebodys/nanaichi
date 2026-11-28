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

@Test("記録が同じまま時刻だけ違うスナップショットに読み込み直しても、その刻みの切り替わりで振動する")
func reloadedSnapshotKeepsVibrating() {
    let session = started()
    var watch = PhaseChangeVibration()
    let vibration = WatchVibration.covering(before: minutes(30))
    #expect(watch.observe(session.snapshot(at: minutes(1), revision: .initial), now: minutes(6, 59), within: vibration) == nil)
    let reloaded = session.snapshot(at: minutes(7), revision: .initial)
    #expect(watch.observe(reloaded, now: minutes(7, 1), within: vibration) == .journal(round: 1, setNumber: 1))
}

@Test("範囲の答えを待つあいだに過ぎた切り替わりは、新しく任された分だけ答えが来てから振動する")
func changeWhileAwaitingAcceptanceVibratesOnce() throws {
    let snapshot = started().snapshot(at: minutes(1), revision: .initial)
    var watch = PhaseChangeVibration()
    // 6:59 に範囲を頼み、答えを待つあいだ（範囲なし）に 7:00 の切り替わりを過ぎた
    #expect(watch.observe(snapshot, now: minutes(6, 59), within: .off) == nil)
    let since = try #require(watch.checkpoint)
    #expect(watch.observe(snapshot, now: minutes(7, 1), within: .off) == nil)
    let accepted = WatchVibration.covering(before: minutes(21, 59))
    #expect(watch.widened(from: .off, to: accepted, since: since) == .journal(round: 1, setNumber: 1))
    // 前の範囲で知らせた切り替わり（範囲を伸ばしたとき）は、もう一度は知らせない
    #expect(watch.widened(from: .covering(before: minutes(10)), to: accepted, since: since) == nil)
    // 答えのあとの刻みでは、もう知らせない
    #expect(watch.observe(snapshot, now: minutes(7, 2), within: accepted) == nil)
}

@Test("端末の時計が戻っても、同じ切り替わりで2回は振動しない")
func clockGoingBackDoesNotRepeat() {
    let snapshot = started().snapshot(at: minutes(1), revision: .initial)
    var watch = PhaseChangeVibration()
    let vibration = WatchVibration.covering(before: minutes(30))
    #expect(watch.observe(snapshot, now: minutes(6, 59), within: vibration) == nil)
    #expect(watch.observe(snapshot, now: minutes(7, 1), within: vibration) == .journal(round: 1, setNumber: 1))
    #expect(watch.observe(snapshot, now: minutes(6, 59), within: vibration) == nil)
    #expect(watch.observe(snapshot, now: minutes(7, 1), within: vibration) == nil)
}

/// 記入の時刻を足したセッション（記録先がジャーナル記入を書いたときと同じく、操作イベントは変わらない）
private func writingJournal(_ session: Session, at: Instant) -> Session {
    Session(
        id: session.id, events: session.events, journalEntryTimes: session.journalEntryTimes + [at],
        advanceModeChanges: session.advanceModeChanges)
}

@Test("記入が増えたスナップショットが切り替わりをまたいで届いても、その切り替わりで振動する")
func journalEntryDoesNotHideTheChange() {
    let session = started()
    var watch = PhaseChangeVibration()
    let vibration = WatchVibration.covering(before: minutes(30))
    // ジャーナルの終わりぎわ（7:59）に書いた記入が、集中に切り替わった（8:00）あとの刻みで届いた
    #expect(watch.observe(session.snapshot(at: minutes(7, 58), revision: .initial), now: minutes(7, 59), within: vibration) == nil)
    let written = writingJournal(session, at: minutes(7, 59)).snapshot(at: minutes(7, 59), revision: .initial)
    #expect(watch.observe(written, now: minutes(8, 1), within: vibration) == .focus(round: 1, setNumber: 2))
}

@Test("範囲の答えを待つあいだに iPhone で休憩をスキップしたら、答えが来ても振動しない")
func skipWhileAwaitingAcceptanceDoesNotVibrate() throws {
    let session = started()
    var watch = PhaseChangeVibration()
    #expect(watch.observe(session.snapshot(at: minutes(28), revision: .initial), now: minutes(28, 59), within: .off) == nil)
    let since = try #require(watch.checkpoint)
    // 休憩の終わる直前に iPhone で休憩をスキップした。Watch には人の操作で替わった記録が届く
    let skipped = try operated(session, .skipBreak, at: minutes(28, 59)).snapshot(at: minutes(28, 59), revision: .initial)
    #expect(watch.observe(skipped, now: minutes(29, 1), within: .off) == nil)
    #expect(watch.widened(from: .off, to: .covering(before: minutes(44)), since: since) == nil)
}

@Test("1ラウンドの切り替わりは、集中→ジャーナル→集中、ジャーナル→休憩、休憩→次のラウンドの集中のどれも1回ずつ振動する")
func everyChangeOfARoundVibrates() {
    let snapshot = started().snapshot(at: minutes(1), revision: .initial)
    let vibrated = vibrations(snapshot, from: minutes(1), to: minutes(30), within: .covering(before: minutes(60)))
    #expect(vibrated.map(\.at) == [minutes(7), minutes(8), minutes(15), minutes(16), minutes(23), minutes(24), minutes(29)])
    #expect(
        vibrated.map(\.to) == [
            .journal(round: 1, setNumber: 1), .focus(round: 1, setNumber: 2), .journal(round: 1, setNumber: 2),
            .focus(round: 1, setNumber: 3), .journal(round: 1, setNumber: 3), .breakTime(round: 1),
            .focus(round: 2, setNumber: 1),
        ])
}

@Test("手動の切り替わりでは、切り替え待ちになるときに1回だけ振動し、進めたときには振動しない")
func manualAdvanceVibratesOnlyWhenAwaiting() throws {
    let session = started(mode: manualToJournal)
    let vibration = WatchVibration.covering(before: minutes(60))
    var watch = PhaseChangeVibration()
    var played: [Phase] = []
    var now = minutes(1)
    while now < minutes(9) {
        if let to = watch.observe(session.snapshot(at: t0, revision: .initial), now: now, within: vibration) {
            played.append(to)
        }
        now = now.adding(milliseconds: 1000)
    }
    #expect(played == [.journal(round: 1, setNumber: 1)])
    // 9分に進めた（人の操作）。替わった刻みでは振動せず、その先の時間が過ぎた切り替わり（10分）で振動する
    let advanced = try operated(session, .advance, at: minutes(9)).snapshot(at: minutes(9), revision: .initial)
    #expect(watch.observe(advanced, now: minutes(9, 1), within: vibration) == nil)
    #expect(watch.observe(advanced, now: minutes(10, 1), within: vibration) == .focus(round: 1, setNumber: 2))
}

@Test("15分の範囲を5分ごとに伸ばしながら2ラウンドを通すと、振動できるあいだは Watch、そのあとは iPhone の通知で、どの切り替わりも1回ずつ知らせる")
func renewingRangeAlertsEachChangeOnce() {
    let session = started()
    let snapshot = session.snapshot(at: minutes(1), revision: .initial)
    // Watch が振動できる（拡張ランタイムセッションが動いている）のは 40 分まで
    let vibratableUntil = minutes(40)
    var watch = PhaseChangeVibration()
    var confirmed = WatchVibration.off
    // iPhone が予約している通知の時刻。範囲を受け取るたびに、そのときから先を予約し直す
    var pending = Set(phaseNotificationPlanOf(snapshot, now: minutes(1), settings: .defaults).map(\.at))
    var vibrated: [Instant] = []
    var notified: [Instant] = []
    var told: [Int64] = []
    var now = minutes(1)
    while now <= minutes(70) {
        if pending.contains(now) { notified.append(now) }
        let until: Instant? = now < vibratableUntil ? vibratableUntil : nil
        if watch.observe(snapshot, now: now, within: until == nil ? .off : confirmed) != nil { vibrated.append(now) }
        if let next = watchVibrationToTell(confirmed: confirmed, vibratableUntil: until, now: now) {
            // iPhone は予約し直してから答える（ここでは答えがすぐ届く）
            pending = Set(phaseNotificationPlanOf(snapshot, now: now, settings: .defaults, watch: next).map(\.at))
            confirmed = next
            told.append(now.milliseconds(since: t0) / 1000)
        }
        now = now.adding(milliseconds: 1000)
    }
    let all = session.upcomingPhaseChanges(after: minutes(1), limit: 64).map(\.at)
    #expect(vibrated == [minutes(7), minutes(8), minutes(15), minutes(16), minutes(23), minutes(24), minutes(29), minutes(36), minutes(37)])
    #expect(!notified.isEmpty)
    #expect(Set(vibrated).isDisjoint(with: notified))
    #expect((vibrated + notified).sorted() == all)
    // 伝えたのは、1分に始めて5分ごとに伸ばした6回（秒）。26分に伸ばした範囲は、振動できるのが終わる30秒前の 39:30 で
    // 頭打ちになり、そこで範囲が切れるので、閉じる（`off`）と伝えなくても iPhone の通知に戻る
    #expect(told == [60, 361, 662, 963, 1264, 1565])
}
