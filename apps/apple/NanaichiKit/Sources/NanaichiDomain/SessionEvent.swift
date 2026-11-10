/// 操作イベント（GLOSSARY の「操作イベント」）の開始。セッションに1回だけで、必ず先頭に来る
///
/// 時間が過ぎたことによるフェーズの切り替わりは記録せず、`deriveTimerState` が時刻から計算する（ADR 0003）。
public struct Start: Hashable, Sendable {
    public let at: Instant

    public init(at: Instant) { self.at = at }
}

/// 開始の後にセッションへ行える操作
public enum SessionOperationKind: String, CaseIterable, Codable, Sendable {
    case pause = "Pause"
    case resume = "Resume"
    case abort = "Abort"
    case restartFocus = "RestartFocus"
    case skipBreak = "SkipBreak"
    /// 切り替え待ちから次のフェーズを始める（ADR 0016）
    case advance = "Advance"
    case end = "End"
}

/// どの操作も行った時刻しか持たないので、種類ごとに型を分けず `kind` で見分ける
public struct SessionOperation: Hashable, Codable, Sendable {
    public let kind: SessionOperationKind
    public let at: Instant

    public init(kind: SessionOperationKind, at: Instant) {
        self.kind = kind
        self.at = at
    }
}

/// 1つのセッションの操作イベントを時刻の順に並べたもの。先頭だけが開始になる
public struct SessionEvents: Hashable, Sendable {
    public let start: Start
    public let operations: [SessionOperation]

    public init(start: Start, operations: [SessionOperation]) {
        self.start = start
        self.operations = operations
    }

    var times: [Instant] { [start.at] + operations.map(\.at) }
}

/// 操作イベントの ID。クライアントが発行する（ADR 0007）。
///
/// 同じ ID の操作が2回届いても1回分しか記録しないことで、通信のやり直しによる二重送信を防ぐ。
public struct SessionEventId: Hashable, Sendable, Codable {
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

/// 記録済みの操作イベント。記録するときに ID が付く
public struct RecordedSessionEvent<Event: Hashable & Sendable & Codable>: Hashable, Sendable, Codable {
    public let id: SessionEventId
    public let event: Event

    public init(id: SessionEventId, event: Event) {
        self.id = id
        self.event = event
    }

    public init(from decoder: any Decoder) throws {
        id = try decoder.fields().decode(SessionEventId.self, forKey: "id")
        event = try Event(from: decoder)
    }

    public func encode(to encoder: any Encoder) throws {
        try event.encode(to: encoder)
        var container = encoder.container(keyedBy: JSONKey.self)
        try container.encode(id, forKey: "id")
    }
}

/// 記録済みの操作イベントを時刻の順に並べたもの
public struct RecordedSessionEvents: Hashable, Sendable {
    public let start: RecordedSessionEvent<Start>
    public let operations: [RecordedSessionEvent<SessionOperation>]

    public init(
        start: RecordedSessionEvent<Start>, operations: [RecordedSessionEvent<SessionOperation>]
    ) {
        self.start = start
        self.operations = operations
    }

    public var unrecorded: SessionEvents {
        SessionEvents(start: start.event, operations: operations.map(\.event))
    }

    func appending(_ operation: RecordedSessionEvent<SessionOperation>) -> RecordedSessionEvents {
        RecordedSessionEvents(start: start, operations: operations + [operation])
    }
}

private enum StartKind: String, Codable {
    case start = "Start"
}

extension Start: Codable {
    public init(from decoder: any Decoder) throws {
        _ = try decoder.kind(StartKind.self)
        at = try decoder.fields().decode(Instant.self, forKey: "at")
    }

    public func encode(to encoder: any Encoder) throws {
        try encoder.encode(kind: StartKind.start) { try $0.encode(at, forKey: "at") }
    }
}

/// JSON では開始と操作を1つの配列に並べる（TS の `[Start, ...SessionOperation[]]`）
extension SessionEvents: Codable {
    public init(from decoder: any Decoder) throws {
        var container = try decoder.unkeyedContainer()
        start = try container.decode(Start.self)
        var operations: [SessionOperation] = []
        while !container.isAtEnd { operations.append(try container.decode(SessionOperation.self)) }
        self.operations = operations
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.unkeyedContainer()
        try container.encode(start)
        try container.encode(contentsOf: operations)
    }
}

extension RecordedSessionEvents: Codable {
    public init(from decoder: any Decoder) throws {
        var container = try decoder.unkeyedContainer()
        start = try container.decode(RecordedSessionEvent<Start>.self)
        var operations: [RecordedSessionEvent<SessionOperation>] = []
        while !container.isAtEnd {
            operations.append(try container.decode(RecordedSessionEvent<SessionOperation>.self))
        }
        self.operations = operations
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.unkeyedContainer()
        try container.encode(start)
        try container.encode(contentsOf: operations)
    }
}

/// valibot の `v.uuid()` と同じ形（16進の 8-4-4-4-12、大文字小文字を問わない）
func isUUID(_ text: String) -> Bool {
    let chars = Array(text.utf8)
    guard chars.count == 36 else { return false }
    return chars.enumerated().allSatisfy { index, c in
        [8, 13, 18, 23].contains(index)
            ? c == UInt8(ascii: "-")
            : (48...57).contains(c) || (65...70).contains(c) || (97...102).contains(c)
    }
}

func decodeUUID(from decoder: any Decoder) throws -> String {
    let container = try decoder.singleValueContainer()
    let text = try container.decode(String.self)
    guard isUUID(text) else {
        throw DecodingError.dataCorruptedError(
            in: container, debugDescription: "UUID として読めない: \(text)")
    }
    return text
}
