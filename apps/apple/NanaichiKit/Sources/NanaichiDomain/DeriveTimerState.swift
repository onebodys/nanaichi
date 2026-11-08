// 計算の途中で持つ状態と、操作イベントからタイマーの状態を計算する純粋な関数（ADR 0003）

private enum Progress {
    case idle(round: Int, setNumber: Int, sets: [SetOutcome])
    /// `phaseStartedAt` は一時停止していた時間の分だけ後ろにずらした、見かけのフェーズ開始時刻
    case running(phase: Phase, sets: [SetOutcome], phaseStartedAt: Instant)
    case paused(phase: Phase, sets: [SetOutcome], elapsedMs: Int64, pausedAt: Instant)
    /// `since` はフェーズの時間が過ぎて切り替え待ちになった時刻
    case awaiting(finished: Phase, sets: [SetOutcome], since: Instant)
    case ended(endedAt: Instant, endedBy: EndedBy, sets: [SetOutcome])

    var sets: [SetOutcome] {
        switch self {
        case .idle(_, _, let sets), .running(_, let sets, _), .paused(_, let sets, _, _),
            .awaiting(_, let sets, _), .ended(_, _, let sets):
            sets
        }
    }

    var stateKind: TimerStateKind {
        switch self {
        case .idle: .idle
        case .ended: .ended
        case .awaiting: .awaitingAdvance
        case .running(let phase, _, _), .paused(let phase, _, _, _):
            switch phase.kind {
            case .focus: .focus
            case .journal: .journal
            case .breakTime: .breakTime
            }
        }
    }
}

/// `mode` はいま効いているフェーズの進め方（ADR 0016）
private struct Derivation {
    let progress: Progress
    let lastActivityAt: Instant
    let mode: AdvanceMode
}

/// 時刻の順に処理するもの。ジャーナル記入は状態を変えないが、自動終了までの時間を延ばす。
/// 進め方の変更は、待っている切り替わりを自動にすれば次のフェーズを始め、操作として自動終了までの時間も延ばす
private enum Activity {
    case operation(SessionOperation)
    case journalEntry(at: Instant)
    case advanceModeChanged(AdvanceModeChange)

    var at: Instant {
        switch self {
        case .operation(let operation): operation.at
        case .journalEntry(let at): at
        case .advanceModeChanged(let change): change.at
        }
    }
}

/// 集中を最後まで終えたセットを完了セットとして残す。集中のほかのフェーズが終わっても何も残さない
private func setsAfterPhaseEnded(_ phase: Phase, _ sets: [SetOutcome], endedAt: Instant)
    -> [SetOutcome]
{
    switch phase {
    case .focus(let round, let setNumber):
        sets + [.completedSet(round: round, setNumber: setNumber, at: endedAt)]
    case .journal, .breakTime:
        sets
    }
}

/// 集中の途中で中断・終了したセットを、不成立セットとして残す。集中の途中でなければ何も残さない
private func setsAfterInterrupted(_ progress: Progress, at t: Instant) -> [SetOutcome] {
    switch progress {
    case .running(.focus(let round, let setNumber), let sets, _),
        .paused(.focus(let round, let setNumber), let sets, _, _):
        sets + [.abortedSet(round: round, setNumber: setNumber, at: t)]
    case .idle, .running, .paused, .awaiting, .ended:
        progress.sets
    }
}

/// 時刻 `t` までに終わったフェーズを、次のフェーズへ切り替える。
/// 進め方 `mode` がその切り替わりを手動にしていれば、終わった時刻から切り替え待ちで止まる
private func advance(_ progress: Progress, to t: Instant, mode: AdvanceMode) -> Progress {
    var current = progress
    while case .running(let phase, let sets, let phaseStartedAt) = current {
        let endsAt = phaseStartedAt.adding(milliseconds: phase.durationMs)
        if endsAt > t { break }
        let next = phase.next
        let sets = setsAfterPhaseEnded(phase, sets, endedAt: endsAt)
        if mode.isManual(from: phase.kind, to: next.kind) {
            return .awaiting(finished: phase, sets: sets, since: endsAt)
        }
        current = .running(phase: next, sets: sets, phaseStartedAt: endsAt)
    }
    return current
}

private func startFocus(round: Int, setNumber: Int, sets: [SetOutcome], at t: Instant) -> Progress {
    .running(phase: .focus(round: round, setNumber: setNumber), sets: sets, phaseStartedAt: t)
}

/// 終了。集中の途中なら、そのセットは完了セットに数えていないので不成立セットになる
private func end(_ progress: Progress, at t: Instant, by endedBy: EndedBy) -> Progress {
    .ended(endedAt: t, endedBy: endedBy, sets: setsAfterInterrupted(progress, at: t))
}

/// 時刻 `operation.at` まで進めた状態に、人の操作を当てはめる
private func apply(_ operation: SessionOperation, to progress: Progress)
    -> Result<Progress, DeriveTimerStateError>
{
    let t = operation.at
    let rejected = Result<Progress, DeriveTimerStateError>.failure(
        .operationRejected(
            OperationRejected(operation: operation.kind, at: t, during: progress.stateKind)))

    switch operation.kind {
    case .pause:
        // どのフェーズでも一時停止できる。待機中はフェーズがないのでできない
        guard case .running(let phase, let sets, let phaseStartedAt) = progress else { return rejected }
        return .success(
            .paused(
                phase: phase, sets: sets, elapsedMs: t.milliseconds(since: phaseStartedAt), pausedAt: t
            ))
    case .resume:
        guard case .paused(let phase, let sets, let elapsedMs, _) = progress else { return rejected }
        return .success(
            .running(phase: phase, sets: sets, phaseStartedAt: t.adding(milliseconds: -elapsedMs)))
    case .abort:
        // 中断は集中中のみ（一時停止中の集中を含む）。待機に戻り、同じセット番号でやり直す
        switch progress {
        case .running(.focus(let round, let setNumber), _, _),
            .paused(.focus(let round, let setNumber), _, _, _):
            return .success(
                .idle(round: round, setNumber: setNumber, sets: setsAfterInterrupted(progress, at: t)))
        case .idle, .running, .paused, .awaiting, .ended:
            return rejected
        }
    case .restartFocus:
        guard case .idle(let round, let setNumber, let sets) = progress else { return rejected }
        return .success(startFocus(round: round, setNumber: setNumber, sets: sets, at: t))
    case .skipBreak:
        // 休憩スキップは休憩中（一時停止中の休憩を含む）と、休憩に入る前の切り替え待ちのみ。
        // 次のラウンドの集中がすぐ始まる
        switch progress {
        case .running(.breakTime(let round), let sets, _), .paused(.breakTime(let round), let sets, _, _):
            return .success(startFocus(round: round + 1, setNumber: 1, sets: sets, at: t))
        case .awaiting(let finished, let sets, _):
            guard case .breakTime(let round) = finished.next else { return rejected }
            return .success(startFocus(round: round + 1, setNumber: 1, sets: sets, at: t))
        case .idle, .running, .paused, .ended:
            return rejected
        }
    case .advance:
        // 進めるのは切り替え待ちのみ。押した時刻から次のフェーズが始まる
        guard case .awaiting(let finished, let sets, _) = progress else { return rejected }
        return .success(.running(phase: finished.next, sets: sets, phaseStartedAt: t))
    case .end:
        if case .ended = progress { return rejected }
        return .success(end(progress, at: t, by: .end))
    }
}

/// 記入も操作もないまま 2ラウンド分が過ぎていたら、最後の記入・操作の時刻で自動終了する。
/// その時刻に終了したのと同じ扱いなので、それより後に終わるはずだったセットは数えない
private func autoEndIfInactive(_ derivation: Derivation, until t: Instant) -> Derivation {
    if case .ended = derivation.progress { return derivation }
    guard t.milliseconds(since: derivation.lastActivityAt) >= autoEndAfterMs else { return derivation }
    let last = derivation.lastActivityAt
    return Derivation(
        progress: end(advance(derivation.progress, to: last, mode: derivation.mode), at: last, by: .autoEnd),
        lastActivityAt: last, mode: derivation.mode)
}

/// 時刻 `t` に進め方を `mode` に変えたあとの状態。待っている切り替わりが自動になったら、
/// その時刻から次のフェーズを始める（ADR 0016）
private func applyAdvanceMode(_ progress: Progress, _ mode: AdvanceMode, at t: Instant) -> Progress {
    guard case .awaiting(let finished, let sets, _) = progress,
        !mode.isManual(from: finished.kind, to: finished.next.kind)
    else { return progress }
    return .running(phase: finished.next, sets: sets, phaseStartedAt: t)
}

private func apply(_ activity: Activity, to derivation: Derivation)
    -> Result<Derivation, DeriveTimerStateError>
{
    let current = autoEndIfInactive(derivation, until: activity.at)
    switch activity {
    case .journalEntry(let at):
        if case .ended = current.progress { return .success(current) }
        return .success(
            Derivation(
                progress: current.progress, lastActivityAt: max(current.lastActivityAt, at),
                mode: current.mode))
    case .operation(let operation):
        return apply(operation, to: advance(current.progress, to: operation.at, mode: current.mode))
            .map { Derivation(progress: $0, lastActivityAt: operation.at, mode: current.mode) }
    case .advanceModeChanged(let change):
        if case .ended = current.progress { return .success(current) }
        return .success(
            Derivation(
                progress: applyAdvanceMode(
                    advance(current.progress, to: change.at, mode: current.mode), change.mode,
                    at: change.at),
                lastActivityAt: change.at, mode: change.mode))
    }
}

/// セッションを始めた時刻 `startedAt` より後で、時刻 `now` までのもの。同じ時刻なら進め方の変更を先にする
private func activitiesBetween(
    _ events: SessionEvents, _ journalEntryTimes: [Instant],
    _ advanceModeChanges: [AdvanceModeChange], now: Instant
) -> [Activity] {
    let activities: [Activity] =
        advanceModeChanges.filter { $0.at > events.start.at }.map(Activity.advanceModeChanged)
        + events.operations.map(Activity.operation)
        + journalEntryTimes.map(Activity.journalEntry)
    // 同じ時刻のものは並べた順を保つ（TS の安定な `toSorted`）
    return activities.enumerated()
        .filter { $0.element.at <= now }
        .sorted { ($0.element.at, $0.offset) < ($1.element.at, $1.offset) }
        .map(\.element)
}

private func toTimerState(_ progress: Progress, now: Instant) -> TimerState {
    func remainingSeconds(_ ms: Int64) -> Int {
        let (quotient, remainder) = ms.quotientAndRemainder(dividingBy: 1000)
        return Int(remainder > 0 ? quotient + 1 : quotient)
    }
    func inPhase(_ phase: Phase, _ completedSets: Int, remainingMs: Int64, _ clock: Clock) -> TimerState {
        let seconds = remainingSeconds(remainingMs)
        switch phase {
        case .focus(let round, let setNumber):
            return .focus(
                .init(
                    round: round, setNumber: setNumber, completedSets: completedSets,
                    remainingSeconds: seconds, clock: clock))
        case .journal(let round, let setNumber):
            return .journal(
                .init(
                    round: round, setNumber: setNumber, completedSets: completedSets,
                    remainingSeconds: seconds, clock: clock))
        case .breakTime(let round):
            return .breakTime(
                .init(round: round, completedSets: completedSets, remainingSeconds: seconds, clock: clock))
        }
    }

    let completedSets = progress.sets.count { $0.kind == .completedSet }
    switch progress {
    case .idle(let round, let setNumber, _):
        return .idle(.init(round: round, setNumber: setNumber, completedSets: completedSets))
    case .running(let phase, _, let phaseStartedAt):
        let endsAt = phaseStartedAt.adding(milliseconds: phase.durationMs)
        return inPhase(
            phase, completedSets, remainingMs: endsAt.milliseconds(since: now), .running(endsAt: endsAt))
    case .paused(let phase, _, let elapsedMs, let pausedAt):
        return inPhase(
            phase, completedSets, remainingMs: phase.durationMs - elapsedMs, .paused(pausedAt: pausedAt))
    case .awaiting(let finished, _, let since):
        return .awaitingAdvance(.init(finished: finished, completedSets: completedSets, since: since))
    case .ended(let endedAt, let endedBy, _):
        return .ended(.init(endedAt: endedAt, endedBy: endedBy, completedSets: completedSets))
    }
}

/// 時刻 `now` までの操作イベントとジャーナル記入を順に当てはめ、`now` まで進めた途中の状態
private func progressAt(
    _ events: SessionEvents, now: Instant, journalEntryTimes: [Instant],
    advanceModeChanges: [AdvanceModeChange]
) -> Result<Progress, DeriveTimerStateError> {
    let times = events.times
    if let (_, outOfOrder) = zip(times, times.dropFirst()).first(where: { $1 < $0 }) {
        return .failure(.eventOutOfOrder(at: outOfOrder))
    }
    let startedAt = events.start.at
    var derivation = Derivation(
        progress: startFocus(round: 1, setNumber: 1, sets: [], at: startedAt),
        lastActivityAt: startedAt, mode: AdvanceModeChange.modeAt(advanceModeChanges, startedAt))
    for activity in activitiesBetween(events, journalEntryTimes, advanceModeChanges, now: now) {
        switch apply(activity, to: derivation) {
        case .success(let next): derivation = next
        case .failure(let error): return .failure(error)
        }
    }
    let current = autoEndIfInactive(derivation, until: now)
    return .success(advance(current.progress, to: now, mode: current.mode))
}

/// 操作イベントと時刻から、時刻 `now` のタイマーの状態を計算する（ADR 0003）。
///
/// フェーズの自動的な切り替わりは記録されていないので、ここで時刻から計算する。
/// `now` より後の操作イベントとジャーナル記入は、まだ起きていないものとして扱わない。
///
/// - `journalEntryTimes`: このセッションのジャーナル記入の時刻。自動終了の判断にだけ使う
/// - `advanceModeChanges`: 進め方の変更履歴（時刻の順）。セッションを始めた時刻に効いていた変更を含める（ADR 0016）
/// - その状態ではできない操作が含まれていれば `operationRejected` を返す。
///   新しい操作を受け付けてよいかは、記録済みのイベントに足して計算し直せば判断できる
func deriveTimerState(
    _ events: SessionEvents, now: Instant, journalEntryTimes: [Instant],
    advanceModeChanges: [AdvanceModeChange]
) -> Result<TimerState, DeriveTimerStateError> {
    progressAt(
        events, now: now, journalEntryTimes: journalEntryTimes, advanceModeChanges: advanceModeChanges
    ).map { toTimerState($0, now: now) }
}

/// 時刻 `now` までに完了セットになったセットの、集中を終えた時刻（古い順）。
/// 計算は `deriveTimerState` と同じなので、数は `completedSets` と必ず一致する
func deriveCompletedSetTimes(
    _ events: SessionEvents, now: Instant, journalEntryTimes: [Instant],
    advanceModeChanges: [AdvanceModeChange]
) -> Result<[Instant], DeriveTimerStateError> {
    deriveSetOutcomes(
        events, now: now, journalEntryTimes: journalEntryTimes, advanceModeChanges: advanceModeChanges
    ).map { $0.filter { $0.kind == .completedSet }.map(\.at) }
}

/// 時刻 `now` までのセットの結末（完了セットと不成立セット）を、時刻の古い順に並べたもの
func deriveSetOutcomes(
    _ events: SessionEvents, now: Instant, journalEntryTimes: [Instant],
    advanceModeChanges: [AdvanceModeChange]
) -> Result<[SetOutcome], DeriveTimerStateError> {
    progressAt(
        events, now: now, journalEntryTimes: journalEntryTimes, advanceModeChanges: advanceModeChanges
    ).map(\.sets)
}

/// 記入も操作もないまま過ぎれば自動終了する時刻（最後の記入・操作から2ラウンド分の位置）。
/// 進め方の変更も操作として数える（ADR 0016）。
///
/// 自動終了そのものは `deriveTimerState` が時刻から計算する。記録先はこの時刻に alarm を張り、
/// 記入や操作があるたびに張り直すことで、誰も見ていなくても自動終了を記録に残す
func autoEndDueAt(
    _ events: SessionEvents, journalEntryTimes: [Instant], advanceModeChanges: [AdvanceModeChange]
) -> Instant {
    // 始める前の変更は自動終了の時刻を延ばさない（始めた時刻のほうが後）
    let last = (events.times + journalEntryTimes + advanceModeChanges.map(\.at)).max()
    guard let last else { preconditionFailure("操作イベントは開始を必ず含む") }
    return last.adding(milliseconds: autoEndAfterMs)
}
