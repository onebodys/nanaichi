public struct SessionId: Hashable, Sendable, Codable {
    public let rawValue: String

    public init?(_ text: String) {
        guard isUUID(text) else { return nil }
        rawValue = text
    }

    public init(from decoder: any Decoder) throws {
        rawValue = try decodeUUID(from: decoder)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// 記録されているセッション（GLOSSARY の「セッション」）。
///
/// 終了したかどうかは持たない。自動終了は時刻から計算するので、記録の上でまだ閉じていなくても
/// 状態は終了でありうる。状態はいつも `stateAt` で操作イベントと時刻から計算する（ADR 0003）。
///
/// - `journalEntryTimes`: このセッションのジャーナル記入の時刻。自動終了の判断にだけ使う
/// - `advanceModeChanges`: このセッションの計算に要る進め方の変更（時刻の順）。
///   始めた時刻に効いていた変更と、セッションの間の変更（ADR 0016）
public struct Session: Hashable, Sendable, Codable {
    public let id: SessionId
    public let events: RecordedSessionEvents
    public let journalEntryTimes: [Instant]
    public let advanceModeChanges: [AdvanceModeChange]

    public init(
        id: SessionId, events: RecordedSessionEvents, journalEntryTimes: [Instant],
        advanceModeChanges: [AdvanceModeChange]
    ) {
        self.id = id
        self.events = events
        self.journalEntryTimes = journalEntryTimes
        self.advanceModeChanges = advanceModeChanges
    }

    /// セッションを始める。1ラウンド目の1セット目の集中がすぐに始まる。
    /// `advanceModeChanges` は進め方の変更履歴で、始めた時刻に効いている変更だけを持つ
    public static func start(
        id: SessionId, startEventId: SessionEventId, now: Instant,
        advanceModeChanges: [AdvanceModeChange]
    ) -> Session {
        Session(
            id: id,
            events: RecordedSessionEvents(
                start: RecordedSessionEvent(id: startEventId, event: Start(at: now)), operations: []),
            journalEntryTimes: [],
            advanceModeChanges: AdvanceModeChange.relevantSince(advanceModeChanges, now))
    }

    /// 進め方を変えたあとのセッション。状態は変えた時刻から変わりうる（ADR 0016）
    public func withAdvanceModeChange(_ change: AdvanceModeChange) -> Session {
        Session(
            id: id, events: events, journalEntryTimes: journalEntryTimes,
            advanceModeChanges: advanceModeChanges + [change])
    }

    /// 時刻 `now` のタイマーの状態。
    ///
    /// 記録済みの操作イベントは受け付けたときに検査しているので、計算できないのは
    /// 記録が壊れているときだけ。想定内の失敗ではなく不変条件違反として止める
    public func stateAt(_ now: Instant) -> TimerState {
        switch derive(events.unrecorded, now: now) {
        case .success(let state): state
        case .failure(let error): preconditionFailure("記録済みの操作イベントから状態を計算できない: \(error)")
        }
    }

    /// セッションに操作を加える。その時点の状態でできない操作なら `OperationRejected` を返す。
    /// 受け付けてよいかは、記録済みのイベントに足して計算し直せば判断できる
    public func operate(_ operation: RecordedSessionEvent<SessionOperation>)
        -> Result<OperatedSession, OperationRejected>
    {
        let operated = Session(
            id: id, events: events.appending(operation), journalEntryTimes: journalEntryTimes,
            advanceModeChanges: advanceModeChanges)
        switch derive(operated.events.unrecorded, now: operation.event.at) {
        case .success(let state):
            return .success(OperatedSession(session: operated, state: state))
        case .failure(.operationRejected(let rejected)):
            return .failure(rejected)
        case .failure(.eventOutOfOrder):
            // 操作の時刻は記録済みのどのイベントより後なので、時刻の順が崩れるのは呼び出し側の誤り
            preconditionFailure("操作イベントの時刻が記録済みのイベントより前になっている")
        }
    }

    /// 時刻 `now` にできる操作。画面はこれで、押せるボタンだけを出す。
    ///
    /// できるかどうかの規則を二重に持たないよう、記録済みのイベントに足して計算し直せるかで判断する
    /// （`operate` と同じ判断）。終了していれば、どの操作もできない
    public func availableOperations(at now: Instant) -> [SessionOperationKind] {
        let recorded = events.unrecorded
        return SessionOperationKind.allCases.filter { kind in
            let events = SessionEvents(
                start: recorded.start,
                operations: recorded.operations + [SessionOperation(kind: kind, at: now)])
            switch derive(events, now: now) {
            case .success: return true
            case .failure: return false
            }
        }
    }

    /// 時刻 `now` までに完了セットになったセットの、集中を終えた時刻。計算できないのは `stateAt` と同じく不変条件違反
    public func completedSetTimesAt(_ now: Instant) -> [Instant] {
        setOutcomesAt(now).filter { $0.kind == .completedSet }.map(\.at)
    }

    /// 時刻 `now` までのセットの結末を古い順に。計算できないのは `stateAt` と同じく不変条件違反
    public func setOutcomesAt(_ now: Instant) -> [SetOutcome] {
        let derived = deriveSetOutcomes(
            events.unrecorded, now: now, journalEntryTimes: journalEntryTimes,
            advanceModeChanges: advanceModeChanges)
        switch derived {
        case .success(let sets): return sets
        case .failure(let error):
            preconditionFailure("記録済みの操作イベントからセットの結末を計算できない: \(error)")
        }
    }

    /// 記入も操作もないまま過ぎれば自動終了する時刻
    public var autoEndDueAt: Instant {
        NanaichiDomain.autoEndDueAt(
            events.unrecorded, journalEntryTimes: journalEntryTimes,
            advanceModeChanges: advanceModeChanges)
    }

    public func snapshot(at now: Instant, revision: Revision) -> SessionSnapshot {
        .session(serverTime: now, revision: revision, session: self, state: stateAt(now))
    }

    private func derive(_ events: SessionEvents, now: Instant) -> Result<TimerState, DeriveTimerStateError> {
        deriveTimerState(
            events, now: now, journalEntryTimes: journalEntryTimes,
            advanceModeChanges: advanceModeChanges)
    }
}

/// 操作を受け付けたあとのセッションと、その時刻の状態
public struct OperatedSession: Hashable, Sendable, Encodable {
    public let session: Session
    public let state: TimerState
}

/// 変更の番号（GLOSSARY）。記録先がセッションの記録を変えるたびに進み、減らない（ADR 0030）
public struct Revision: Hashable, Comparable, Sendable, Codable {
    public let rawValue: Int

    /// 何も記録していない記録先の番号
    public static let initial = Revision(validated: 0)

    public init?(_ value: Int) {
        guard value >= 0 else { return nil }
        rawValue = value
    }

    private init(validated value: Int) { rawValue = value }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        guard let revision = Revision(try container.decode(Int.self)) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "変更の番号は 0 以上")
        }
        self = revision
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static func < (lhs: Revision, rhs: Revision) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// ある時刻のセッションの様子。API の応答にそのまま使う。
///
/// クライアントは `session` から自分で状態を計算し直し、`serverTime` との差で端末の時計のずれを補正する（ADR 0003）。
/// `revision` は作ったときの変更の番号で、届いたものの新旧を決める（`isOlder`、ADR 0030）
public enum SessionSnapshot: Hashable, Sendable {
    case noSession(serverTime: Instant, revision: Revision)
    case session(serverTime: Instant, revision: Revision, session: Session, state: TimerState)

    public var serverTime: Instant {
        switch self {
        case .noSession(let serverTime, _), .session(let serverTime, _, _, _): serverTime
        }
    }

    public var revision: Revision {
        switch self {
        case .noSession(_, let revision), .session(_, let revision, _, _): revision
        }
    }

    /// 届いたスナップショットが、手元のスナップショット `current` より古いか。
    ///
    /// 同じ変更が HTTP の応答と同期メッセージの両方で届き、順序が入れ替わることがある（ADR 0012）。
    /// 変更の番号が小さいものは、それより後の変更を巻き戻してしまうので捨てる（ADR 0030）。
    /// サーバーの時刻では決めない。同時に届いた要求は同じミリ秒に処理されうるので、変更の前と後で
    /// 同じ時刻になることがある。同じ番号なら同じ記録から作ったものなので、サーバーの時刻が前のものだけを古いとみなす
    public func isOlder(than current: SessionSnapshot) -> Bool {
        (revision, serverTime) < (current.revision, current.serverTime)
    }
}

extension SessionSnapshot: Codable {
    private enum Kind: String, Codable {
        case noSession = "NoSession"
        case session = "Session"
    }

    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        let serverTime = try fields.decode(Instant.self, forKey: "serverTime")
        let revision = try fields.decode(Revision.self, forKey: "revision")
        switch try decoder.kind(Kind.self) {
        case .noSession:
            self = .noSession(serverTime: serverTime, revision: revision)
        case .session:
            self = .session(
                serverTime: serverTime, revision: revision,
                session: try fields.decode(Session.self, forKey: "session"),
                state: try fields.decode(TimerState.self, forKey: "state"))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .noSession(let serverTime, let revision):
            try encoder.encode(kind: Kind.noSession) {
                try $0.encode(serverTime, forKey: "serverTime")
                try $0.encode(revision, forKey: "revision")
            }
        case .session(let serverTime, let revision, let session, let state):
            try encoder.encode(kind: Kind.session) {
                try $0.encode(serverTime, forKey: "serverTime")
                try $0.encode(revision, forKey: "revision")
                try $0.encode(session, forKey: "session")
                try $0.encode(state, forKey: "state")
            }
        }
    }
}

// MARK: - 読み書きの契約

/// セッションの読み書きの契約（TS の `FindOpenSession` ほか）。記録先の障害は例外で投げる
public protocol SessionStore {
    /// 閉じていないセッション。自動終了の時刻を過ぎていても、閉じるまではここに出る
    func findOpenSession() throws -> Session?
    /// 操作イベント `eventId` を含むセッション（閉じたものも含む）
    func findSessionByEventId(_ eventId: SessionEventId) throws -> Session?
    /// 始めたばかりのセッションを、開始の操作イベントとともに記録する
    func saveStartedSession(_ session: Session) throws
    func appendSessionOperation(_ sessionId: SessionId, _ operation: RecordedSessionEvent<SessionOperation>) throws
    /// セッションを閉じる。閉じたセッションは閉じ直さない
    func closeSession(_ sessionId: SessionId, _ ended: TimerState.Ended) throws
    /// 記録の今の変更の番号（TS の `CurrentRevision`）。セッション・操作イベント・記入・進め方の変更を書くたびに進む。
    /// 書いたあとに読めば書いたあとの番号が返る（ADR 0030）
    func currentRevision() throws -> Revision
}
