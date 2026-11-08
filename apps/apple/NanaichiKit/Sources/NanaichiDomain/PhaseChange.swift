/// 2つの時刻のタイマーの状態を比べた結果（GLOSSARY の「フェーズの切り替わり」）。
///
/// - `phaseChanged`: 別のフェーズに移った。`to` は移った先のフェーズ。
///   手動の切り替わりで切り替え待ちになったときも、これから移る先のフェーズとして知らせる（ADR 0016）
/// - `unchanged`: 同じフェーズのまま（一時停止しただけ、残り時間が減っただけを含む）か、
///   フェーズのない状態（待機・終了）になった
public enum PhaseChange: Hashable, Sendable {
    case phaseChanged(to: Phase)
    case unchanged
}

/// その状態が向かっているフェーズ。フェーズの中ならそのフェーズ、切り替え待ちなら次に始まるフェーズ
private func headingOf(_ state: TimerState) -> Phase? {
    switch state {
    case .focus(let state): .focus(round: state.round, setNumber: state.setNumber)
    case .journal(let state): .journal(round: state.round, setNumber: state.setNumber)
    case .breakTime(let state): .breakTime(round: state.round)
    case .awaitingAdvance(let state): state.finished.next
    case .idle, .ended: nil
    }
}

/// `previous` から `current` へのフェーズの切り替わり。
///
/// 同じ操作イベントから計算した、前後2つの時刻の状態を渡す。その間に人の操作はないので、
/// フェーズが変わっていれば時間が過ぎたことによる切り替わりで、知らせる対象になる。
/// 人の操作で変わった状態どうしを比べてはいけない（本人が押したので知らせない）。
///
/// 切り替え待ちは次に始まるフェーズに向かっているものとして比べる。切り替え待ちになったときに知らせ、
/// 進めて次のフェーズが始まったときは同じフェーズなので知らせない。
/// 端末がスリープしていたなどで間のフェーズを飛ばしたときは、最後に移った先だけを返す。
public func phaseChangeBetween(_ previous: TimerState, _ current: TimerState) -> PhaseChange {
    guard let to = headingOf(current), headingOf(previous) != to else { return .unchanged }
    return .phaseChanged(to: to)
}

extension PhaseChange: Encodable {
    private enum Kind: String {
        case phaseChanged = "PhaseChanged"
        case unchanged = "Unchanged"
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .phaseChanged(let to):
            try encoder.encode(kind: Kind.phaseChanged) { try $0.encode(to, forKey: "to") }
        case .unchanged:
            try encoder.encode(kind: Kind.unchanged) { _ in }
        }
    }
}
