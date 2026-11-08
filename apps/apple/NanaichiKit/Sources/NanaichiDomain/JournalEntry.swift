/// ジャーナル記入の ID。クライアントが発行する（ADR 0010）。
///
/// 同じ ID の記入が2回届いても1件しか記録しないことで、通信のやり直しによる二重送信を防ぐ。
public struct JournalEntryId: Hashable, Sendable, Codable {
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

/// ジャーナル記入の本文。プレーンテキスト（改行可）で、前後の空白は落とす。空の記入は書けない。
///
/// 本文は PII なので、検証するとその場で `Sensitive` に包む（AGENTS.md「境界での検証と PII」）
public struct JournalEntryBody: Hashable, Sendable {
    public let text: Sensitive<String>

    /// 1件の記入の長さの上限（JS の `length` と同じく UTF-16 で数える）。
    /// 1分のジャーナルで書く量には十分で、誤って巨大な本文を送るのを防ぐ
    static let maxLength = 10_000

    public init?(_ input: String) {
        let trimmed = input.jsTrimmed
        guard (1...JournalEntryBody.maxLength).contains(trimmed.jsLength) else { return nil }
        text = Sensitive(trimmed)
    }

    public func unwrap() -> String { text.unwrap() }
}

/// 書いた時点のタイマーの状態のうち、記入に紐付けるもの（GLOSSARY の「ジャーナル記入」）。
///
/// - 集中・ジャーナル: ラウンドとセットとフェーズに紐付く
/// - 休憩: どのセットにも属さないので、ラウンドとフェーズだけ
/// - 待機: どのフェーズにもないので、ラウンドと次にやり直すセットだけ
/// - 切り替え待ち: 時間が過ぎて終わったフェーズとして紐付ける（専用の種類は持たない）
public enum WrittenDuring: Hashable, Sendable {
    case focus(round: Int, setNumber: Int)
    case journal(round: Int, setNumber: Int)
    case breakTime(round: Int)
    case idle(round: Int, setNumber: Int)

    init(_ phase: Phase) {
        switch phase {
        case .focus(let round, let setNumber): self = .focus(round: round, setNumber: setNumber)
        case .journal(let round, let setNumber): self = .journal(round: round, setNumber: setNumber)
        case .breakTime(let round): self = .breakTime(round: round)
        }
    }
}

/// セッションの外（終了したあとを含む）では書けない
public struct NoSessionInProgress: Error, Hashable, Encodable {
    private enum Kind: String { case noSessionInProgress = "NoSessionInProgress" }

    public func encode(to encoder: any Encoder) throws {
        try encoder.encode(kind: Kind.noSessionInProgress) { _ in }
    }
}

/// ジャーナル記入（GLOSSARY の「ジャーナル記入」）。
///
/// - `tags`: つけたタグ（GLOSSARY の「タグ」）。つけた順で、つけていなければ空
/// - `writtenAt`: 書いた時刻。編集しても変わらない
/// - `updatedAt`: 最後に書いた・編集した時刻
///
/// JSON にするときは本文を取り出す（TS の `JournalEntry.toJson`、ADR 0010）。JSON にするのは API の応答・
/// 同期メッセージ・記録先に書くときだけで、ログやエラーの文字列は `description` を通るので本文は伏せられる
public struct JournalEntry: Hashable, Sendable {
    public let id: JournalEntryId
    public let sessionId: SessionId
    public let body: JournalEntryBody
    public let tags: [TagName]
    public let writtenAt: Instant
    public let updatedAt: Instant
    public let writtenDuring: WrittenDuring

    public init(
        id: JournalEntryId, sessionId: SessionId, body: JournalEntryBody, tags: [TagName],
        writtenAt: Instant, updatedAt: Instant, writtenDuring: WrittenDuring
    ) {
        self.id = id
        self.sessionId = sessionId
        self.body = body
        self.tags = tags
        self.writtenAt = writtenAt
        self.updatedAt = updatedAt
        self.writtenDuring = writtenDuring
    }

    /// 記入を書く。書いた時点のセッションの状態に紐付ける。
    ///
    /// `state` は書いた時刻 `now` のタイマーの状態。終了していれば（自動終了を含む）セッションの外なので書けない
    public static func write(
        id: JournalEntryId, body: JournalEntryBody, tags: [TagName], sessionId: SessionId,
        state: TimerState, now: Instant
    ) -> Result<JournalEntry, NoSessionInProgress> {
        writtenDuring(of: state).map { writtenDuring in
            JournalEntry(
                id: id, sessionId: sessionId, body: body, tags: tags, writtenAt: now, updatedAt: now,
                writtenDuring: writtenDuring)
        }
    }

    private static func writtenDuring(of state: TimerState) -> Result<WrittenDuring, NoSessionInProgress> {
        switch state {
        case .focus(let s): .success(.focus(round: s.round, setNumber: s.setNumber))
        case .journal(let s): .success(.journal(round: s.round, setNumber: s.setNumber))
        case .idle(let s): .success(.idle(round: s.round, setNumber: s.setNumber))
        case .breakTime(let s): .success(.breakTime(round: s.round))
        // 切り替え待ちの間に書いたものは、時間が過ぎて終わったフェーズに紐付く（GLOSSARY）
        case .awaitingAdvance(let s): .success(WrittenDuring(s.finished))
        case .ended: .failure(NoSessionInProgress())
        }
    }

    /// 本文とタグを書き直す。書いた時刻と紐付きは変えない（ADR 0010）
    public func edit(body: JournalEntryBody, tags: [TagName], now: Instant) -> JournalEntry {
        JournalEntry(
            id: id, sessionId: sessionId, body: body, tags: tags, writtenAt: writtenAt, updatedAt: now,
            writtenDuring: writtenDuring)
    }

    /// 削除したタグを記入から外す（付け替えるなら付け替え先に置き換える）。記入を編集するのではないので、
    /// 更新時刻は変えない（GLOSSARY の「タグの削除」、ADR 0017）
    public func deletingTag(_ deleted: DeletedTag) -> JournalEntry {
        JournalEntry(
            id: id, sessionId: sessionId, body: body, tags: deleted.apply(to: tags),
            writtenAt: writtenAt, updatedAt: updatedAt, writtenDuring: writtenDuring)
    }
}

/// 削除した記入。削除は論理削除で、タイムラインには出ない（ADR 0010）
public struct DeletedJournalEntry: Hashable, Sendable, Codable {
    public let id: JournalEntryId
    public let deletedAt: Instant

    public init(id: JournalEntryId, deletedAt: Instant) {
        self.id = id
        self.deletedAt = deletedAt
    }
}

// MARK: - JSON（API の応答と同じ形。ADR 0009）

extension WrittenDuring: Codable {
    private enum Kind: String, Codable {
        case focus = "Focus"
        case journal = "Journal"
        case breakTime = "Break"
        case idle = "Idle"
    }

    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        let round = try fields.decode("round", atLeast: 1)
        func setNumber() throws -> Int { try fields.decode("setNumber", atLeast: 1) }
        switch try decoder.kind(Kind.self) {
        case .focus: self = .focus(round: round, setNumber: try setNumber())
        case .journal: self = .journal(round: round, setNumber: try setNumber())
        case .breakTime: self = .breakTime(round: round)
        case .idle: self = .idle(round: round, setNumber: try setNumber())
        }
    }

    public func encode(to encoder: any Encoder) throws {
        func write(_ kind: Kind, _ round: Int, _ setNumber: Int) throws {
            try encoder.encode(kind: kind) {
                try $0.encode(round, forKey: "round")
                try $0.encode(setNumber, forKey: "setNumber")
            }
        }
        switch self {
        case .focus(let round, let setNumber): try write(.focus, round, setNumber)
        case .journal(let round, let setNumber): try write(.journal, round, setNumber)
        case .idle(let round, let setNumber): try write(.idle, round, setNumber)
        case .breakTime(let round):
            try encoder.encode(kind: Kind.breakTime) { try $0.encode(round, forKey: "round") }
        }
    }
}

extension JournalEntry: Codable {
    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        // 読めなかった本文をエラーの文に入れない
        guard let body = JournalEntryBody(try fields.decode(String.self, forKey: "body")) else {
            throw DecodingError.dataCorruptedError(
                forKey: "body", in: fields, debugDescription: "本文が空か長すぎる")
        }
        self.init(
            id: try fields.decode(JournalEntryId.self, forKey: "id"),
            sessionId: try fields.decode(SessionId.self, forKey: "sessionId"),
            body: body,
            tags: try Tags.decode(fields, forKey: "tags"),
            writtenAt: try fields.decode(Instant.self, forKey: "writtenAt"),
            updatedAt: try fields.decode(Instant.self, forKey: "updatedAt"),
            writtenDuring: try fields.decode(WrittenDuring.self, forKey: "writtenDuring"))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: JSONKey.self)
        try container.encode(id, forKey: "id")
        try container.encode(sessionId, forKey: "sessionId")
        try container.encode(body.unwrap(), forKey: "body")
        try container.encode(tags, forKey: "tags")
        try container.encode(writtenAt, forKey: "writtenAt")
        try container.encode(updatedAt, forKey: "updatedAt")
        try container.encode(writtenDuring, forKey: "writtenDuring")
    }
}
