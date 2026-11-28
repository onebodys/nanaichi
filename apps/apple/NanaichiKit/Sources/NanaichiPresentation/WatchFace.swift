import NanaichiDomain

/// Watch から iPhone に届くか（ADR 0031）。届かないあいだ、Watch は操作を受け付けない
public enum PhoneReach: Hashable, Sendable {
    case reachable
    case unreachable
}

/// Watch の操作ボタンを押せるか
public enum WatchControl: Hashable, Sendable {
    case enabled
    /// 頼んだ操作の応答を iPhone から待っている。二重に頼まないよう押せなくする
    case pending
    /// iPhone に届かない
    case phoneUnreachable

    static func of(reach: PhoneReach, pending: Bool) -> WatchControl {
        switch (reach, pending) {
        case (.unreachable, _): .phoneUnreachable
        case (.reachable, true): .pending
        case (.reachable, false): .enabled
        }
    }

    public var isEnabled: Bool {
        switch self {
        case .enabled: true
        case .pending, .phoneUnreachable: false
        }
    }
}

/// Watch の画面に出すもの（ADR 0031）。Watch でできない操作（`isWatchOperation`）は出さない
public struct WatchFace: Hashable, Sendable {
    public let screen: WatchScreen
    public let reach: PhoneReach

    /// iPhone から届いたスナップショットで計算したタイマーの様子 `view` と、iPhone に届くか、応答を待っているかから決める
    public static func of(_ view: TimerView, reach: PhoneReach, pending: Bool) -> WatchFace {
        let control = WatchControl.of(reach: reach, pending: pending)
        let screen: WatchScreen =
            switch view {
            // Watch は読み込みに失敗しない（届くまで待つ）が、iPhone の画面と同じ型を使うので並べる
            case .loading, .loadFailed: .waitingForPhone
            case .noSession, .ended: .outOfSession(start: control)
            case .inSession(_, let state, let operations):
                .inSession(
                    state: state, operations: operationButtonsOf(operations).filter { isWatchOperation($0.kind) },
                    control: control)
            }
        return WatchFace(screen: screen, reach: reach)
    }

    /// iPhone に届かないことを知らせる文言。届くなら出さない
    public var phoneUnreachableNotice: String? {
        switch reach {
        case .reachable: nil
        case .unreachable: "iPhone に繋がっていません"
        }
    }
}

public enum WatchScreen: Hashable, Sendable {
    /// iPhone からまだスナップショットが届いていない
    case waitingForPhone
    /// セッションの外（始める前・終了したあと）。開始できる
    case outOfSession(start: WatchControl)
    /// セッション中。`operations` はいまできる操作のうち Watch でできるものを、主な操作から順に並べたもの
    case inSession(state: UnendedTimerState, operations: [OperationButton], control: WatchControl)
}

/// Watch でできるセッション中の操作（ADR 0031）。集中の再開始・休憩スキップ・進めるは iPhone で行う
func isWatchOperation(_ kind: SessionOperationKind) -> Bool {
    switch kind {
    case .pause, .resume, .abort, .end: true
    case .restartFocus, .skipBreak, .advance: false
    }
}

/// Watch が頼んだのに iPhone から答えが返らなかったときの文言
public let phoneDidNotAnswerMessage = "iPhone に届きませんでした。もう一度お試しください。"
