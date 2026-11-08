/// ラウンドの中の1区切り（セットの集中、または休憩）の進み具合。
///
/// - `done`: 終えた。セットは集中を最後まで終えていれば、ジャーナル中や切り替え待ちでも終えたとみなす
/// - `current`: 進めているところ。`elapsedRatio` は経過した割合（0〜1）
/// - `pending`: まだ。中断したセットは、やり直すまでまだとみなす
public enum Segment: Hashable, Sendable {
    case done
    case current(elapsedRatio: Double)
    case pending
}

/// いまのラウンドの進み具合。セットごと（ラウンドのセット数だけ並ぶ）と、最後の休憩
public struct RoundProgress: Hashable, Sendable, Codable {
    public let sets: [Segment]
    public let breakTime: Segment

    enum CodingKeys: String, CodingKey {
        case sets
        case breakTime = "break"
    }
}

/// フェーズの残り時間の割合（1 = 始まったばかり、0 = 終わる）。一時停止中は止めたときの割合
public func remainingRatioOf(_ state: InPhase) -> Double {
    Double(state.remainingSeconds * 1000) / Double(state.phase.durationMs)
}

/// フェーズの時間が過ぎたときに移る先（GLOSSARY の「フェーズの切り替わり」）
public func upcomingPhaseOf(_ state: InPhase) -> Phase {
    state.phase.next
}

/// セット番号 `setNumber` のセットが、いまの状態でどこまで進んでいるか
private func setSegmentOf(_ state: UnendedTimerState, _ setNumber: Int) -> Segment {
    switch state {
    case .breakTime:
        return .done
    case .idle(let idle):
        return setNumber < idle.setNumber ? .done : .pending
    case .journal(let journal):
        return setNumber <= journal.setNumber ? .done : .pending
    case .awaitingAdvance(let awaiting):
        // 終わったフェーズまでは終えている。休憩のあとの切り替え待ちなら、このラウンドはすべて終えた
        switch awaiting.finished {
        case .breakTime: return .done
        case .focus(_, let finished), .journal(_, let finished):
            return setNumber <= finished ? .done : .pending
        }
    case .focus(let focus):
        if setNumber < focus.setNumber { return .done }
        if setNumber > focus.setNumber { return .pending }
        return .current(elapsedRatio: 1 - remainingRatioOf(.focus(focus)))
    }
}

private func breakSegmentOf(_ state: UnendedTimerState) -> Segment {
    switch state {
    case .breakTime(let breakTime):
        .current(elapsedRatio: 1 - remainingRatioOf(.breakTime(breakTime)))
    case .awaitingAdvance(let awaiting):
        awaiting.finished.kind == .breakTime ? .done : .pending
    case .idle, .focus, .journal:
        .pending
    }
}

/// いまのラウンドの進み具合。待機・一時停止中も、その時点までの進み具合を返す
public func roundProgressOf(_ state: UnendedTimerState) -> RoundProgress {
    RoundProgress(
        sets: (1...setsPerRound).map { setSegmentOf(state, $0) }, breakTime: breakSegmentOf(state))
}

/// 休憩に入るまでに、あと何セット（進めているセットを含む）。休憩中は 0
public func setsUntilBreakOf(_ progress: RoundProgress) -> Int {
    progress.sets.count { $0 != .done }
}

extension Segment: Codable {
    private enum Kind: String, Codable {
        case done = "Done"
        case current = "Current"
        case pending = "Pending"
    }

    public init(from decoder: any Decoder) throws {
        switch try decoder.kind(Kind.self) {
        case .done: self = .done
        case .current:
            self = .current(
                elapsedRatio: try decoder.fields().decode(Double.self, forKey: "elapsedRatio"))
        case .pending: self = .pending
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .done: try encoder.encode(kind: Kind.done) { _ in }
        case .current(let elapsedRatio):
            try encoder.encode(kind: Kind.current) {
                try $0.encode(elapsedRatio, forKey: "elapsedRatio")
            }
        case .pending: try encoder.encode(kind: Kind.pending) { _ in }
        }
    }
}
