import NanaichiDomain

/// メニューバーの記号が表すもの。どの SF Symbol で描くかはアプリが決める
public enum MenuBarSymbol: Hashable, Sendable {
    /// セッションの外（開始前・終了後・読み込み中）
    case outOfSession
    case idle
    case paused
    /// そのフェーズの中か、切り替え待ちならこれから始まるフェーズ
    case phase(PhaseKind)
}

/// メニューバーに常に出す、タイマーの小さな表示（ADR 0015「メニューバー常駐」）。
/// 残り時間が秒単位なので、値が変わるのは1秒に1回まで。アプリは値が変わったときだけ描き直す
public enum MenuBarLabel: Hashable, Sendable {
    /// 記号だけ。時計の進まないとき（セッションの外と待機）
    case symbolOnly(MenuBarSymbol, spoken: String)
    /// 記号と残り時間（`m:ss`）
    case countdown(MenuBarSymbol, text: String, spoken: String)

    public var symbol: MenuBarSymbol {
        switch self {
        case .symbolOnly(let symbol, _), .countdown(let symbol, _, _): symbol
        }
    }

    /// VoiceOver で読み上げる文言
    public var spoken: String {
        switch self {
        case .symbolOnly(_, let spoken), .countdown(_, _, let spoken): spoken
        }
    }
}

public func menuBarLabelOf(_ view: TimerView) -> MenuBarLabel {
    switch view {
    case .loading, .loadFailed, .noSession, .ended:
        return .symbolOnly(.outOfSession, spoken: "nanaichi")
    case .inSession(_, let state, _):
        switch state {
        case .idle:
            return .symbolOnly(.idle, spoken: "nanaichi \(stateNameOf(.idle))")
        case .awaitingAdvance(let awaiting):
            return .countdown(
                .phase(awaiting.finished.next.kind), text: countdownTextOf(remainingSeconds: 0),
                spoken: "\(phaseNameOf(awaiting.finished.kind))が終わりました")
        case .focus(let focus): return countdownLabelOf(.focus(focus))
        case .journal(let journal): return countdownLabelOf(.journal(journal))
        case .breakTime(let breakTime): return countdownLabelOf(.breakTime(breakTime))
        }
    }
}

private func countdownLabelOf(_ inPhase: InPhase) -> MenuBarLabel {
    let kind = inPhase.phase.kind
    let text = countdownTextOf(remainingSeconds: inPhase.remainingSeconds)
    let remaining = countdownAccessibilityTextOf(remainingSeconds: inPhase.remainingSeconds)
    switch inPhase.clock {
    case .running: return .countdown(.phase(kind), text: text, spoken: "\(phaseNameOf(kind)) \(remaining)")
    case .paused: return .countdown(.paused, text: text, spoken: "\(phaseNameOf(kind)) 一時停止中 \(remaining)")
    }
}
