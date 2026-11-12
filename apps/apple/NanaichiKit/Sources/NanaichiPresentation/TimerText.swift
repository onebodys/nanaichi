import NanaichiDomain

// 画面に出す文言。判断はせず、ドメインの値を言葉にするだけ（AGENTS.md §5、Web の timer-text.ts と同じ文言）

/// カウントダウンの表示（`m:ss`）
public func countdownTextOf(remainingSeconds: Int) -> String {
    "\(remainingSeconds / 60):\(pad2(remainingSeconds % 60))"
}

/// カウントダウンの読み上げ（`残り 6分 59秒`）
public func countdownAccessibilityTextOf(remainingSeconds: Int) -> String {
    let minutes = remainingSeconds / 60
    let seconds = remainingSeconds % 60
    return minutes == 0 ? "残り \(seconds)秒" : "残り \(minutes)分 \(seconds)秒"
}

private func minutesOf(_ phase: Phase) -> Int64 { phase.durationMs / 60_000 }

/// フェーズの時間が過ぎたら何に移るか（`次は ジャーナル 1分`）
public func upcomingTextOf(_ upcoming: Phase) -> String {
    switch upcoming {
    case .focus(let round, let setNumber):
        setNumber == 1 ? "次は \(round)ラウンド目の集中" : "次は 集中（\(setNumber)セット目）"
    case .journal: "次は ジャーナル \(minutesOf(upcoming))分"
    case .breakTime: "次は 休憩 \(minutesOf(upcoming))分"
    }
}

/// 休憩まであと何セットか。休憩中は出さない
public func untilBreakTextOf(_ progress: RoundProgress) -> String? {
    let sets = setsUntilBreakOf(progress)
    return sets == 0 ? nil : "休憩まで あと\(sets)セット"
}

/// 開始前に出す、1セットの流れとラウンドの決まり
public struct SessionRhythm: Hashable, Sendable {
    public let focusSeconds: Int
    public let set: String
    public let round: String
}

public func sessionRhythmOf() -> SessionRhythm {
    let focus = Phase.focus(round: 1, setNumber: 1)
    return SessionRhythm(
        focusSeconds: Int(focus.durationMs / 1000),
        set: "集中 \(minutesOf(focus))分 → ジャーナル \(minutesOf(.journal(round: 1, setNumber: 1)))分",
        round: "\(setsPerRound)セットごとに \(minutesOf(.breakTime(round: 1)))分の休憩が入ります")
}

public func phaseNameOf(_ phase: PhaseKind) -> String {
    switch phase {
    case .focus: "集中"
    case .journal: "ジャーナル"
    case .breakTime: "休憩"
    }
}

public func stateNameOf(_ state: TimerStateKind) -> String {
    switch state {
    case .focus: "集中"
    case .journal: "ジャーナル"
    case .breakTime: "休憩"
    case .idle: "待機"
    case .awaitingAdvance: "切り替え待ち"
    case .ended: "終了"
    }
}

private func positionOf(_ phase: Phase) -> String {
    switch phase {
    case .focus(let round, let setNumber), .journal(let round, let setNumber):
        "\(round)ラウンド目・\(setNumber)セット目"
    case .breakTime(let round): "\(round)ラウンド目"
    }
}

/// 何ラウンド目・何セット目か。休憩はどのセットにも属さないのでラウンドだけ。切り替え待ちは、終わったフェーズの位置
public func positionTextOf(_ state: UnendedTimerState) -> String {
    switch state {
    case .focus(let state): positionOf(.focus(round: state.round, setNumber: state.setNumber))
    case .journal(let state): positionOf(.journal(round: state.round, setNumber: state.setNumber))
    case .idle(let state): positionOf(.focus(round: state.round, setNumber: state.setNumber))
    case .breakTime(let state): positionOf(.breakTime(round: state.round))
    case .awaitingAdvance(let state): positionOf(state.finished)
    }
}

public func operationTextOf(_ kind: SessionOperationKind) -> String {
    switch kind {
    case .pause: "一時停止"
    case .resume: "再開"
    case .abort: "中断"
    case .restartFocus: "集中を再開始"
    case .skipBreak: "休憩をスキップ"
    case .advance: "次へ進む"
    case .end: "終了"
    }
}

/// 切り替え待ちから進める操作の文言。何が始まるかで言う（`ジャーナルを始める`）
public func advanceTextOf(_ next: Phase) -> String {
    switch next {
    case .focus: "集中を始める"
    case .journal: "ジャーナルを始める"
    case .breakTime: "休憩に入る"
    }
}

/// 操作ボタンの文言。切り替え待ちから進めるのは、何が始まるかで言う
public func operationButtonTextOf(_ kind: SessionOperationKind, _ state: UnendedTimerState) -> String {
    if kind == .advance, case .awaitingAdvance(let awaiting) = state {
        return advanceTextOf(awaiting.finished.next)
    }
    return operationTextOf(kind)
}

private func agoOf(_ from: Instant, _ now: Instant) -> (minutes: Int, seconds: Int) {
    let seconds = max(0, Int(now.milliseconds(since: from) / 1000))
    return (seconds / 60, seconds % 60)
}

/// 切り替え待ちで出す、何が終わったかと待っている時間（`集中が終わりました · 2分13秒前`）。1分未満は秒だけ
public func awaitingTextOf(finished: Phase, since: Instant, now: Instant) -> String {
    let (minutes, seconds) = agoOf(since, now)
    let ago = minutes == 0 ? "\(seconds)秒前" : "\(minutes)分\(pad2(seconds))秒前"
    return "\(phaseNameOf(finished.kind))が終わりました · \(ago)"
}

/// 一時停止中に出す、止めてからの時間（`止めてから 2分13秒`）。1分未満は秒だけ
public func pausedForTextOf(pausedAt: Instant, now: Instant) -> String {
    let (minutes, seconds) = agoOf(pausedAt, now)
    return minutes == 0 ? "止めてから \(seconds)秒" : "止めてから \(minutes)分\(pad2(seconds))秒"
}

/// フェーズの切り替わりを知らせる通知の文言
public struct PhaseChangeMessage: Hashable, Sendable {
    public let title: String
    public let body: String
}

public func phaseChangeMessageOf(_ to: Phase) -> PhaseChangeMessage {
    switch to {
    case .focus(let round, let setNumber):
        PhaseChangeMessage(title: "集中の時間です", body: "\(round)ラウンド目・\(setNumber)セット目の集中を始めます")
    case .journal(let round, let setNumber):
        PhaseChangeMessage(
            title: "ジャーナルの時間です", body: "\(round)ラウンド目・\(setNumber)セット目の振り返りと、次にやることの整理")
    case .breakTime(let round):
        PhaseChangeMessage(title: "休憩の時間です", body: "\(round)ラウンド目が終わりました")
    }
}

/// 中断のあとの待機で出す説明。待機は中断の直後にだけなる（GLOSSARY の「待機」）
public func idleMessageOf(setNumber: Int) -> PhaseChangeMessage {
    PhaseChangeMessage(
        title: "\(setNumber)セット目を中断しました", body: "集中を再開始すると、\(setNumber)セット目の集中をはじめからやり直します")
}

/// 端末のタイムゾーンでの時刻（`09:05`）
public func timeTextOf(_ at: Instant, timeZone: TimeZoneName) -> String {
    let minuteOfDay = timeZone.localTime(at: at).minuteOfDay
    return "\(pad2(minuteOfDay / 60)):\(pad2(minuteOfDay % 60))"
}

/// セッション中にタイマーの下に出す、このセッションの積み上げ（`このセッション 13:05〜 · 完了 4セット · 集中 28分`）
public func currentSessionTextOf(startedAt: Instant, completedSets: Int, timeZone: TimeZoneName) -> String {
    "このセッション \(timeTextOf(startedAt, timeZone: timeZone))〜 · \(completedSetsAndFocusTimeOf(completedSets))"
}

/// セッションのまとめの、始めた時刻と終わった時刻（`13:05 〜 15:02`）
public func sessionSpanTextOf(startedAt: Instant, endedAt: Instant, timeZone: TimeZoneName) -> String {
    "\(timeTextOf(startedAt, timeZone: timeZone)) 〜 \(timeTextOf(endedAt, timeZone: timeZone))"
}

/// セットの並びの点線の説明。不成立セットがなければ出さない
public func abortedSetsNoteOf(_ abortedSets: Int) -> String? {
    abortedSets == 0 ? nil : "点線は不成立セット（\(abortedSets)セット）"
}

/// 終了の文言。自動終了なら、記入も操作もないまま時間が過ぎたことを伝える
public func endedMessageOf(_ endedBy: EndedBy) -> String {
    switch endedBy {
    case .autoEnd: "記入も操作もないまま時間が過ぎたので、セッションを自動終了しました"
    case .end: "セッションを終了しました"
    }
}

/// まとめに出す記入の数。数えられるまでは `—`
public func entryCountTextOf(_ entries: EntryCount) -> String {
    switch entries {
    case .counted(let count): String(count)
    case .notYetCounted: "—"
    }
}

// MARK: - 集中時間（Web の focus-time-text.ts）

/// 集中時間（`1時間10分`、1時間に満たなければ `42分`）
public func focusTimeTextOf(milliseconds: Int64) -> String {
    let totalMinutes = milliseconds / 60_000
    let hours = totalMinutes / 60
    return hours == 0 ? "\(totalMinutes % 60)分" : "\(hours)時間\(totalMinutes % 60)分"
}

/// 完了セットの数と、その集中時間（`完了 4セット · 集中 28分`）
public func completedSetsAndFocusTimeOf(_ completedSets: Int) -> String {
    "完了 \(completedSets)セット · 集中 \(focusTimeTextOf(milliseconds: FocusTime.ofCompletedSets(completedSets)))"
}

/// ツールバーに出す今日の集中時間。数えられるまでは出さない
public enum TodayFocus: Hashable, Sendable {
    case counted(completedSets: Int)
    case unknown
}

public struct TodayFocusText: Hashable, Sendable {
    public let focusTime: String
    public let sets: String
}

public func todayFocusTextOf(_ today: TodayFocus) -> TodayFocusText? {
    switch today {
    case .counted(let completedSets):
        TodayFocusText(
            focusTime: focusTimeTextOf(milliseconds: FocusTime.ofCompletedSets(completedSets)),
            sets: "\(completedSets)セット")
    case .unknown: nil
    }
}

private func pad2(_ value: Int) -> String { value < 10 ? "0\(value)" : String(value) }
