// MVP では時間とセット数のカスタム設定を作らないので固定する（docs/PRODUCT.md「タイマー」）
private let minuteMs: Int64 = 60_000
let focusMs = 7 * minuteMs
let journalMs = 1 * minuteMs
let breakMs = 5 * minuteMs
/// 休憩までのセット数（GLOSSARY の「ラウンド」）
public let setsPerRound = 3
private let roundMs = Int64(setsPerRound) * (focusMs + journalMs) + breakMs
/// 自動終了までの、ジャーナル記入も操作もない時間（2ラウンド分 = 58分）
let autoEndAfterMs = 2 * roundMs

public enum PhaseKind: String, Codable, Sendable {
    case focus = "Focus"
    case journal = "Journal"
    case breakTime = "Break"
}

/// フェーズ（GLOSSARY）。集中・ジャーナルはセットに、休憩はラウンドに属する
public enum Phase: Hashable, Sendable {
    case focus(round: Int, setNumber: Int)
    case journal(round: Int, setNumber: Int)
    case breakTime(round: Int)

    public var kind: PhaseKind {
        switch self {
        case .focus: .focus
        case .journal: .journal
        case .breakTime: .breakTime
        }
    }

    var durationMs: Int64 {
        switch self {
        case .focus: focusMs
        case .journal: journalMs
        case .breakTime: breakMs
        }
    }

    /// フェーズの自動的な切り替わり: 集中 → ジャーナル → … 3セット後に休憩 → 次のラウンドの集中
    var next: Phase {
        switch self {
        case .focus(let round, let setNumber):
            .journal(round: round, setNumber: setNumber)
        case .journal(let round, let setNumber):
            setNumber < setsPerRound
                ? .focus(round: round, setNumber: setNumber + 1) : .breakTime(round: round)
        case .breakTime(let round):
            .focus(round: round + 1, setNumber: 1)
        }
    }
}

/// フェーズの時計。一時停止中は進まないので、次の切り替わり時刻を持たない
public enum Clock: Hashable, Sendable {
    case running(endsAt: Instant)
    case paused(pausedAt: Instant)
}

/// 1つのセットの結末（GLOSSARY の「完了セット」「不成立セット」）。`at` は集中を終えた時刻か、
/// 中断・終了した時刻
public enum SetOutcome: Hashable, Sendable {
    case completedSet(round: Int, setNumber: Int, at: Instant)
    case abortedSet(round: Int, setNumber: Int, at: Instant)

    public var kind: SetOutcomeKind {
        switch self {
        case .completedSet: .completedSet
        case .abortedSet: .abortedSet
        }
    }

    public var at: Instant {
        switch self {
        case .completedSet(_, _, let at), .abortedSet(_, _, let at): at
        }
    }
}

public enum SetOutcomeKind: String, Codable, Sendable {
    case completedSet = "CompletedSet"
    case abortedSet = "AbortedSet"
}

public enum EndedBy: String, Codable, Sendable {
    case end = "End"
    case autoEnd = "AutoEnd"
}

public enum TimerStateKind: String, Codable, Sendable {
    case idle = "Idle"
    case focus = "Focus"
    case journal = "Journal"
    case breakTime = "Break"
    case awaitingAdvance = "AwaitingAdvance"
    case ended = "Ended"
}

/// ある時刻のタイマーの状態（`deriveTimerState` の返り値）
public enum TimerState: Hashable, Sendable {
    case idle(Idle)
    case focus(Focus)
    case journal(Journal)
    case breakTime(Break)
    case awaitingAdvance(AwaitingAdvance)
    case ended(Ended)

    public struct Idle: Hashable, Sendable, Encodable {
        public let round: Int
        public let setNumber: Int
        public let completedSets: Int
    }

    public struct Focus: Hashable, Sendable, Encodable {
        public let round: Int
        public let setNumber: Int
        public let completedSets: Int
        public let remainingSeconds: Int
        public let clock: Clock
    }

    public struct Journal: Hashable, Sendable, Encodable {
        public let round: Int
        public let setNumber: Int
        public let completedSets: Int
        public let remainingSeconds: Int
        public let clock: Clock
    }

    /// 休憩はどのセットにも属さないので、セット番号を持たない
    public struct Break: Hashable, Sendable, Encodable {
        public let round: Int
        public let completedSets: Int
        public let remainingSeconds: Int
        public let clock: Clock
    }

    /// 切り替え待ち（GLOSSARY）。進め方が手動の切り替わりで `finished` のフェーズの時間が過ぎ、
    /// 人が進めるまで次のフェーズを始めずに待っている。`since` は待ち始めた時刻
    public struct AwaitingAdvance: Hashable, Sendable, Encodable {
        public let finished: Phase
        public let completedSets: Int
        public let since: Instant
    }

    public struct Ended: Hashable, Sendable, Encodable {
        public let endedAt: Instant
        public let endedBy: EndedBy
        public let completedSets: Int
    }

    public var kind: TimerStateKind {
        switch self {
        case .idle: .idle
        case .focus: .focus
        case .journal: .journal
        case .breakTime: .breakTime
        case .awaitingAdvance: .awaitingAdvance
        case .ended: .ended
        }
    }
}

/// フェーズのどれかにあるタイマーの状態（待機・切り替え待ち・終了を除く）
public enum InPhase: Hashable, Sendable {
    case focus(TimerState.Focus)
    case journal(TimerState.Journal)
    case breakTime(TimerState.Break)

    public init?(_ state: TimerState) {
        switch state {
        case .focus(let focus): self = .focus(focus)
        case .journal(let journal): self = .journal(journal)
        case .breakTime(let breakTime): self = .breakTime(breakTime)
        case .idle, .awaitingAdvance, .ended: return nil
        }
    }

    var phase: Phase {
        switch self {
        case .focus(let state): .focus(round: state.round, setNumber: state.setNumber)
        case .journal(let state): .journal(round: state.round, setNumber: state.setNumber)
        case .breakTime(let state): .breakTime(round: state.round)
        }
    }

    var remainingSeconds: Int {
        switch self {
        case .focus(let state): state.remainingSeconds
        case .journal(let state): state.remainingSeconds
        case .breakTime(let state): state.remainingSeconds
        }
    }
}

/// 終了していないタイマーの状態（TS の `Exclude<TimerState, Ended>`）
public enum UnendedTimerState: Hashable, Sendable {
    case idle(TimerState.Idle)
    case focus(TimerState.Focus)
    case journal(TimerState.Journal)
    case breakTime(TimerState.Break)
    case awaitingAdvance(TimerState.AwaitingAdvance)

    public init?(_ state: TimerState) {
        switch state {
        case .idle(let idle): self = .idle(idle)
        case .focus(let focus): self = .focus(focus)
        case .journal(let journal): self = .journal(journal)
        case .breakTime(let breakTime): self = .breakTime(breakTime)
        case .awaitingAdvance(let awaiting): self = .awaitingAdvance(awaiting)
        case .ended: return nil
        }
    }
}

/// その状態ではできない操作（休憩中の中断、待機中の一時停止、終了後の操作など）
public struct OperationRejected: Error, Hashable, Encodable {
    public let operation: SessionOperationKind
    public let at: Instant
    public let during: TimerStateKind

    private enum Kind: String { case operationRejected = "OperationRejected" }

    public func encode(to encoder: any Encoder) throws {
        try encoder.encode(kind: Kind.operationRejected) {
            try $0.encode(operation, forKey: "operation")
            try $0.encode(at, forKey: "at")
            try $0.encode(during, forKey: "during")
        }
    }
}

public enum DeriveTimerStateError: Error, Hashable, Encodable {
    case operationRejected(OperationRejected)
    /// 操作イベントが時刻の順に並んでいない
    case eventOutOfOrder(at: Instant)

    private enum Kind: String { case eventOutOfOrder = "EventOutOfOrder" }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .operationRejected(let rejected):
            try rejected.encode(to: encoder)
        case .eventOutOfOrder(let at):
            try encoder.encode(kind: Kind.eventOutOfOrder) { try $0.encode(at, forKey: "at") }
        }
    }
}

// MARK: - JSON（API の応答と同じ形。ADR 0009）

extension Phase: Codable {
    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        let round = try fields.decode("round", atLeast: 1)
        switch try decoder.kind(PhaseKind.self) {
        case .focus: self = .focus(round: round, setNumber: try fields.decode("setNumber", atLeast: 1))
        case .journal:
            self = .journal(round: round, setNumber: try fields.decode("setNumber", atLeast: 1))
        case .breakTime: self = .breakTime(round: round)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .focus(let round, let setNumber), .journal(let round, let setNumber):
            try encoder.encode(kind: kind) {
                try $0.encode(round, forKey: "round")
                try $0.encode(setNumber, forKey: "setNumber")
            }
        case .breakTime(let round):
            try encoder.encode(kind: kind) { try $0.encode(round, forKey: "round") }
        }
    }
}

extension Clock: Codable {
    private enum Kind: String, Codable {
        case running = "Running"
        case paused = "Paused"
    }

    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        switch try decoder.kind(Kind.self) {
        case .running: self = .running(endsAt: try fields.decode(Instant.self, forKey: "endsAt"))
        case .paused: self = .paused(pausedAt: try fields.decode(Instant.self, forKey: "pausedAt"))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .running(let endsAt):
            try encoder.encode(kind: Kind.running) { try $0.encode(endsAt, forKey: "endsAt") }
        case .paused(let pausedAt):
            try encoder.encode(kind: Kind.paused) { try $0.encode(pausedAt, forKey: "pausedAt") }
        }
    }
}

extension SetOutcome: Codable {
    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        let round = try fields.decode("round", atLeast: 1)
        let setNumber = try fields.decode("setNumber", atLeast: 1)
        let at = try fields.decode(Instant.self, forKey: "at")
        switch try decoder.kind(SetOutcomeKind.self) {
        case .completedSet: self = .completedSet(round: round, setNumber: setNumber, at: at)
        case .abortedSet: self = .abortedSet(round: round, setNumber: setNumber, at: at)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .completedSet(let round, let setNumber, let at),
            .abortedSet(let round, let setNumber, let at):
            try encoder.encode(kind: kind) {
                try $0.encode(round, forKey: "round")
                try $0.encode(setNumber, forKey: "setNumber")
                try $0.encode(at, forKey: "at")
            }
        }
    }
}

extension TimerState: Codable {
    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        func count(_ key: JSONKey) throws -> Int { try fields.decode(key, atLeast: 0) }
        func number(_ key: JSONKey) throws -> Int { try fields.decode(key, atLeast: 1) }
        func clock() throws -> Clock { try fields.decode(Clock.self, forKey: "clock") }
        switch try decoder.kind(TimerStateKind.self) {
        case .idle:
            self = .idle(
                Idle(
                    round: try number("round"), setNumber: try number("setNumber"),
                    completedSets: try count("completedSets")))
        case .focus:
            self = .focus(
                Focus(
                    round: try number("round"), setNumber: try number("setNumber"),
                    completedSets: try count("completedSets"),
                    remainingSeconds: try count("remainingSeconds"), clock: try clock()))
        case .journal:
            self = .journal(
                Journal(
                    round: try number("round"), setNumber: try number("setNumber"),
                    completedSets: try count("completedSets"),
                    remainingSeconds: try count("remainingSeconds"), clock: try clock()))
        case .breakTime:
            self = .breakTime(
                Break(
                    round: try number("round"), completedSets: try count("completedSets"),
                    remainingSeconds: try count("remainingSeconds"), clock: try clock()))
        case .awaitingAdvance:
            self = .awaitingAdvance(
                AwaitingAdvance(
                    finished: try fields.decode(Phase.self, forKey: "finished"),
                    completedSets: try count("completedSets"),
                    since: try fields.decode(Instant.self, forKey: "since")))
        case .ended:
            self = .ended(
                Ended(
                    endedAt: try fields.decode(Instant.self, forKey: "endedAt"),
                    endedBy: try fields.decode(EndedBy.self, forKey: "endedBy"),
                    completedSets: try count("completedSets")))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .idle(let state): try encoder.encode(kind: kind, state)
        case .focus(let state): try encoder.encode(kind: kind, state)
        case .journal(let state): try encoder.encode(kind: kind, state)
        case .breakTime(let state): try encoder.encode(kind: kind, state)
        case .awaitingAdvance(let state): try encoder.encode(kind: kind, state)
        case .ended(let state): try encoder.encode(kind: kind, state)
        }
    }
}
