import NanaichiDomain

/// 操作ボタンの目立たせ方（Web の operation-layout.ts）
public enum Emphasis: Int, Hashable, Sendable, Comparable {
    /// いちばん押される操作。1つだけ
    case primary
    /// 止める操作（中断など）。控えめにする
    case secondary
    /// セッションを閉じる操作（終了）。文字だけにする
    case quiet

    public static func < (lhs: Emphasis, rhs: Emphasis) -> Bool { lhs.rawValue < rhs.rawValue }
}

public struct OperationButton: Hashable, Sendable {
    public let kind: SessionOperationKind
    public let emphasis: Emphasis
}

/// 開始のアイコン（SF Symbols の名前）。Watch はアイコンだけ、iPhone はアイコンと文言を並べる（Issue #122）
public let startSymbol = "play.fill"

/// 操作のアイコン。時間を動かし始める操作（再開・集中の再開始・進める）は開始と同じ ▶ にする。
/// ■ は中断にも終了にも読めるので使わない（Issue #122）。同じ状態でできる操作どうしは、アイコンが重ならない
public func operationSymbolOf(_ kind: SessionOperationKind) -> String {
    switch kind {
    case .resume, .restartFocus, .advance: startSymbol
    case .pause: "pause.fill"
    case .abort: "xmark"
    // 休憩の前の切り替え待ちでは進めると並ぶので、▶ とは別にする
    case .skipBreak: "forward.end.fill"
    case .end: "power"
    }
}

/// 止まっているタイマーを先へ進める操作。あればこれを主にする
private func isMovingOn(_ kind: SessionOperationKind) -> Bool {
    switch kind {
    case .resume, .restartFocus, .skipBreak, .advance: true
    case .pause, .abort, .end: false
    }
}

/// その状態でできる操作を、目立たせ方をつけて主な操作から順に並べる（Issue #34 の A 案）。
///
/// 先へ進める操作（再開・集中の再開始・休憩スキップ・進める）があればそれを主にし、なければ一時停止を主にする。
/// 切り替え待ちで進めると休憩スキップの両方ができるときは、進めるを主にする（主な操作は1つだけ）。
/// 終了はいつでも最後に、文字だけで置く
public func operationButtonsOf(_ operations: [SessionOperationKind]) -> [OperationButton] {
    let hasMovingOn = operations.contains(where: isMovingOn)
    let hasAdvance = operations.contains(.advance)
    func emphasisOf(_ kind: SessionOperationKind) -> Emphasis {
        switch kind {
        case .end: .quiet
        case .skipBreak where hasAdvance: .secondary
        case .resume, .restartFocus, .skipBreak, .advance: .primary
        case .pause: hasMovingOn ? .secondary : .primary
        case .abort: .secondary
        }
    }
    // 安定な並べ替えで、同じ目立たせ方の中ではドメインが返した順を保つ
    return operations.enumerated()
        .map { (offset: $0.offset, button: OperationButton(kind: $0.element, emphasis: emphasisOf($0.element))) }
        .sorted { ($0.button.emphasis, $0.offset) < ($1.button.emphasis, $1.offset) }
        .map(\.button)
}
