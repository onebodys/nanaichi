import NanaichiDomain
import Testing

@testable import NanaichiPresentation

@Test("スナップショットの操作イベントから、端末の今の時刻の状態とできる操作を計算し直す")
func timerViewRecomputesState() {
    let view = TimerView.of(.loaded(received(started(), at: t0)), deviceNow: minutes(7, 30))
    guard case .inSession(_, .journal(let journal), let operations) = view else {
        Issue.record("ジャーナルになっていない: \(view)")
        return
    }
    #expect(journal.remainingSeconds == 30)
    #expect(operations == [.pause, .end])
    #expect(view.journalPhase == .journal(round: 1, setNumber: 1))
}

@Test("時計のずれを足した記録先の時刻で計算する")
func timerViewAppliesClockOffset() {
    let offset = Received(snapshot: started().snapshot(at: t0), offset: ClockOffset(serverAheadMs: 60_000))
    guard case .inSession(_, .focus(let focus), _) = TimerView.of(.loaded(offset), deviceNow: minutes(1)) else {
        Issue.record("集中になっていない")
        return
    }
    #expect(focus.remainingSeconds == 5 * 60)
}

@Test("終了したセッションは終了として出し、記入は書けない")
func timerViewEnded() throws {
    let ended = try operated(started(), .end, at: minutes(3))
    let view = TimerView.of(.loaded(received(ended, at: minutes(3))), deviceNow: minutes(4))
    guard case .ended(_, let state) = view else {
        Issue.record("終了になっていない")
        return
    }
    #expect(state.endedBy == .end)
    #expect(view.writableSession == nil)
}

@Test("手元より古いスナップショットは捨て、同じ時刻なら置き換える")
func olderSnapshotsAreDropped() throws {
    let paused = try operated(started(), .pause, at: minutes(3))
    let current = TimerLoading.loaded(received(paused, at: minutes(3)))
    #expect(current.applying(received(started(), at: minutes(2))) == current)
    let newer = received(try operated(paused, .resume, at: minutes(4)), at: minutes(4))
    #expect(current.applying(newer) == .loaded(newer))
}

@Test("読み込めたあとに読み込みに失敗しても、手元のスナップショットを出し続ける")
func loadFailureKeepsLoaded() {
    let loaded = TimerLoading.loaded(received(started(), at: t0))
    #expect(loaded.failingToLoad() == loaded)
    #expect(TimerLoading.loading.failingToLoad() == .loadFailed)
}

@Test("同じスナップショットのまま時間が過ぎてフェーズが変わったら、移った先を知らせる")
func watchAlertsOnTimeDrivenChange() {
    let snapshot = started().snapshot(at: t0)
    var watch = PhaseChangeWatch()
    #expect(watch.observe(snapshot, started().stateAt(minutes(6))) == nil)
    #expect(watch.observe(snapshot, started().stateAt(minutes(7))) == .journal(round: 1, setNumber: 1))
    #expect(watch.observe(snapshot, started().stateAt(minutes(7, 1))) == nil)
}

@Test("スナップショットが替わった（人が操作した）ときは知らせない")
func watchIgnoresHumanChanges() throws {
    let session = started()
    let idle = try operated(session, .abort, at: minutes(3))
    let restarted = try operated(idle, .restartFocus, at: minutes(4))
    var watch = PhaseChangeWatch()
    _ = watch.observe(idle.snapshot(at: minutes(3)), idle.stateAt(minutes(3)))
    #expect(watch.observe(restarted.snapshot(at: minutes(4)), restarted.stateAt(minutes(4))) == nil)
}
