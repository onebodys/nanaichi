import NanaichiDomain

/// 受け取ったスナップショットと、そのときに測った時計のずれ（Web の use-session-timer.ts の `Received`）
public struct Received: Hashable, Sendable {
    public let snapshot: SessionSnapshot
    public let offset: ClockOffset

    public init(snapshot: SessionSnapshot, offset: ClockOffset) {
        self.snapshot = snapshot
        self.offset = offset
    }

    /// 端末の時刻 `deviceNow` のときの、記録先の時刻の見積もり
    public func serverNow(deviceNow: Instant) -> Instant {
        offset.serverNow(deviceNow: deviceNow, snapshotServerTime: snapshot.serverTime)
    }
}

/// タイマーの読み込みの状態
public enum TimerLoading: Hashable, Sendable {
    case loading
    case loadFailed
    case loaded(Received)

    /// 届いたスナップショットを反映する。手元より古いものは捨てる（ADR 0012）。
    /// 操作の応答と同期メッセージは、同じ変更について順序が入れ替わって届くことがあるため
    public func applying(_ received: Received) -> TimerLoading {
        if case .loaded(let current) = self, received.snapshot.isOlder(than: current.snapshot) { return self }
        return .loaded(received)
    }

    /// 読み込みに失敗した。読み込めているなら、手元のスナップショットを出し続ける
    public func failingToLoad() -> TimerLoading {
        switch self {
        case .loaded: self
        case .loading, .loadFailed: .loadFailed
        }
    }

    public var received: Received? {
        switch self {
        case .loaded(let received): received
        case .loading, .loadFailed: nil
        }
    }
}

/// 画面に出すタイマーの様子
public enum TimerView: Hashable, Sendable {
    case loading
    case loadFailed
    case noSession
    case inSession(session: Session, state: UnendedTimerState, operations: [SessionOperationKind])
    /// 終了した（自動終了を含む）。次のセッションを開始できる
    case ended(session: Session, state: TimerState.Ended)

    /// 端末の時刻 `deviceNow` のタイマーの様子。
    ///
    /// スナップショットの操作イベントから、時計のずれで補正した記録先の時刻での状態を計算し直す（ADR 0003）
    public static func of(_ loading: TimerLoading, deviceNow: Instant) -> TimerView {
        switch loading {
        case .loading: return .loading
        case .loadFailed: return .loadFailed
        case .loaded(let received):
            switch received.snapshot {
            case .noSession: return .noSession
            case .session(_, let session, _):
                let now = received.serverNow(deviceNow: deviceNow)
                let state = session.stateAt(now)
                if let unended = UnendedTimerState(state) {
                    return .inSession(session: session, state: unended, operations: session.availableOperations(at: now))
                }
                guard case .ended(let ended) = state else { preconditionFailure("終了していない状態が残っている") }
                return .ended(session: session, state: ended)
            }
        }
    }

    /// ジャーナル記入を書けるセッション。終了したあとは書けない
    public var writableSession: SessionId? {
        switch self {
        case .inSession(let session, _, _): session.id
        case .loading, .loadFailed, .noSession, .ended: nil
        }
    }

    /// ジャーナルのフェーズにいれば、そのセット。入ったことを見分けて入力欄にカーソルを置くのに使う
    public var journalPhase: Phase? {
        guard case .inSession(_, .journal(let journal), _) = self else { return nil }
        return .journal(round: journal.round, setNumber: journal.setNumber)
    }

    /// セッション中（待機・一時停止・切り替え待ちを含む）か
    public var isInSession: Bool { writableSession != nil }
}

/// フェーズの切り替わりを音で知らせるかを、刻みごとに判断する（Web の use-session-timer.ts と同じ判断）。
///
/// 同じスナップショット（＝同じ操作イベント）から計算した前回の状態と比べる。スナップショットが替わったのは
/// 人の操作なので、知らせずに比べる相手だけを替える（GLOSSARY の「フェーズの切り替わり」）
public struct PhaseChangeWatch: Sendable {
    private var previous: (snapshot: SessionSnapshot, state: TimerState)?

    public init() {}

    /// 今の状態を見て、知らせるべき切り替わりがあれば移った先のフェーズを返す
    public mutating func observe(_ snapshot: SessionSnapshot?, _ state: TimerState?) -> Phase? {
        guard let snapshot, let state else {
            previous = nil
            return nil
        }
        defer { previous = (snapshot, state) }
        guard let previous, previous.snapshot == snapshot else { return nil }
        switch phaseChangeBetween(previous.state, state) {
        case .phaseChanged(let to): return to
        case .unchanged: return nil
        }
    }
}
