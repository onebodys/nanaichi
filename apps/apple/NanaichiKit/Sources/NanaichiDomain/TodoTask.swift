/// タスクの ID。クライアントが発行する（ADR 0010 のジャーナル記入と同じ）。
///
/// 同じ ID のタスクを2回作っても1件しか記録しないことで、通信のやり直しによる二重作成を防ぐ
public struct TaskId: Hashable, Sendable, Codable {
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

/// タスクのタイトル。前後の空白は落とす。空のタスクは作れない
public struct TaskTitle: Hashable, Sendable {
    public let rawValue: String

    /// タイトルの長さの上限（JS の `length` と同じく UTF-16 で数える）。
    /// やることを一言で書く場所なので、長い文章は入れない
    static let maxLength = 200

    public init?(_ input: String) {
        let trimmed = input.jsTrimmed
        guard (1...TaskTitle.maxLength).contains(trimmed.jsLength) else { return nil }
        rawValue = trimmed
    }
}

/// 判断モデルが答える確率。0 から 1 で、「やり終えた」と言い切れる度合い（GLOSSARY の「判断モデル」）
public struct Probability: Hashable, Comparable, Sendable {
    public let value: Double

    public init?(_ value: Double) {
        guard (0...1).contains(value) else { return nil }
        self.value = value
    }

    public static func < (lhs: Probability, rhs: Probability) -> Bool { lhs.value < rhs.value }

    /// 自動で完了にする確率のしきい値（以上）。これに届かないときは何もしない（ADR 0026）
    public static let autoCompleteThreshold = Probability(0.9)!
}

/// 完了のしかた（GLOSSARY の「完了のしかた」）
public enum TaskCompletion: Hashable, Sendable {
    /// ユーザーが自分で完了にした
    case manual
    /// ジャーナル記入から自動で完了にした。もとの記入と、判断モデルが答えた確率を持つ
    case fromJournal(entryId: JournalEntryId, probability: Probability)
}

/// 未完了のタスク
public struct OpenTask: Hashable, Sendable {
    public let id: TaskId
    public let title: TaskTitle
    public let createdAt: Instant
    public let updatedAt: Instant

    /// 完了にする
    public func complete(_ completion: TaskCompletion, now: Instant) -> CompletedTask {
        CompletedTask(
            id: id, title: title, createdAt: createdAt, updatedAt: now, completedAt: now,
            completion: completion)
    }
}

/// 完了したタスク。完了した時刻とそのしかたを必ず持つ
public struct CompletedTask: Hashable, Sendable {
    public let id: TaskId
    public let title: TaskTitle
    public let createdAt: Instant
    public let updatedAt: Instant
    public let completedAt: Instant
    public let completion: TaskCompletion

    /// 未完了に戻す。完了した時刻とそのしかたは消える
    public func reopen(now: Instant) -> OpenTask {
        OpenTask(id: id, title: title, createdAt: createdAt, updatedAt: now)
    }
}

/// タスク（GLOSSARY の「タスク」）。
///
/// GLOSSARY の英語名は Task だが、Swift では `Task` にすると、このパッケージを import した側で
/// Swift Concurrency の `Task { }` が使えなくなる（同じ名前の型が標準ライブラリより優先される）。そのため `TodoTask` にする
public enum TodoTask: Hashable, Sendable {
    case open(OpenTask)
    case completed(CompletedTask)

    public var id: TaskId {
        switch self {
        case .open(let task): task.id
        case .completed(let task): task.id
        }
    }

    /// 最後に変えた時刻。応答と同期メッセージが前後して届いたとき、新しい内容を古い内容で戻さないために使う
    public var updatedAt: Instant {
        switch self {
        case .open(let task): task.updatedAt
        case .completed(let task): task.updatedAt
        }
    }

    public static func create(id: TaskId, title: TaskTitle, now: Instant) -> OpenTask {
        OpenTask(id: id, title: title, createdAt: now, updatedAt: now)
    }

    /// タイトルを変える。未完了でも完了でもできる
    public func renamed(_ title: TaskTitle, now: Instant) -> TodoTask {
        switch self {
        case .open(let task):
            .open(OpenTask(id: task.id, title: title, createdAt: task.createdAt, updatedAt: now))
        case .completed(let task):
            .completed(
                CompletedTask(
                    id: task.id, title: title, createdAt: task.createdAt, updatedAt: now,
                    completedAt: task.completedAt, completion: task.completion))
        }
    }

    /// 判断モデルの答えから、ジャーナル記入 `entryId` で完了にするタスクを決める（GLOSSARY の「ジャーナルからの完了」）。
    ///
    /// しきい値（`Probability.autoCompleteThreshold`）以上の確率で答えられた、まだ未完了のタスクだけを完了にする。
    /// 答えたあとに完了にされた・削除されたタスクや、知らないタスクへの答えは無視する。
    /// 同じタスクに答えが複数あれば、いちばん高い確率を使う
    public static func completedByJournal(
        _ tasks: [TodoTask], judgments: [TaskJudgment], entryId: JournalEntryId, now: Instant
    ) -> [CompletedTask] {
        let highest = judgments.reduce(into: [TaskId: Probability]()) { highest, judgment in
            highest[judgment.taskId] = max(
                highest[judgment.taskId] ?? judgment.probability, judgment.probability)
        }
        return tasks.compactMap { task in
            guard case .open(let open) = task, let probability = highest[open.id],
                probability >= Probability.autoCompleteThreshold
            else { return nil }
            return open.complete(.fromJournal(entryId: entryId, probability: probability), now: now)
        }
    }
}

/// 判断モデルが答えた、1つのタスクが「やり終えた」と言える確率
public struct TaskJudgment: Hashable, Sendable, Codable {
    public let taskId: TaskId
    public let probability: Probability

    public init(taskId: TaskId, probability: Probability) {
        self.taskId = taskId
        self.probability = probability
    }
}

/// タスクが記録されていない（ADR 0026）
public struct TaskNotFound: Error, Hashable, Encodable {
    public let id: TaskId

    private enum Kind: String { case taskNotFound = "TaskNotFound" }

    public func encode(to encoder: any Encoder) throws {
        try encoder.encode(kind: Kind.taskNotFound) { try $0.encode(id, forKey: "id") }
    }
}

/// タスクの一覧（`GET /api/tasks`）。作った順
public struct TaskList: Hashable, Sendable, Codable {
    public let tasks: [TodoTask]

    public init(tasks: [TodoTask]) { self.tasks = tasks }
}

/// 削除したタスク（`DELETE /api/tasks/:id` の応答、同期メッセージの `TaskDeleted`）
public struct DeletedTask: Hashable, Sendable, Codable {
    public let id: TaskId

    public init(id: TaskId) { self.id = id }
}

// MARK: - JSON（API の応答と同じ形。ADR 0009）

extension TaskTitle: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        guard let title = TaskTitle(try container.decode(String.self)) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "タイトルが空か長すぎる")
        }
        self = title
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

extension Probability: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(Double.self)
        guard let probability = Probability(value) else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "0 から 1 の確率ではない: \(value)")
        }
        self = probability
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }
}

extension TaskCompletion: Codable {
    private enum Kind: String, Codable {
        case manual = "Manual"
        case fromJournal = "FromJournal"
    }

    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        switch try decoder.kind(Kind.self) {
        case .manual: self = .manual
        case .fromJournal:
            self = .fromJournal(
                entryId: try fields.decode(JournalEntryId.self, forKey: "entryId"),
                probability: try fields.decode(Probability.self, forKey: "probability"))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .manual: try encoder.encode(kind: Kind.manual) { _ in }
        case .fromJournal(let entryId, let probability):
            try encoder.encode(kind: Kind.fromJournal) {
                try $0.encode(entryId, forKey: "entryId")
                try $0.encode(probability, forKey: "probability")
            }
        }
    }
}

private enum TodoTaskKind: String, Codable {
    case open = "Open"
    case completed = "Completed"
}

extension OpenTask: Codable {
    public init(from decoder: any Decoder) throws {
        guard try decoder.kind(TodoTaskKind.self) == .open else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "未完了のタスクではない"))
        }
        let fields = try decoder.fields()
        id = try fields.decode(TaskId.self, forKey: "id")
        title = try fields.decode(TaskTitle.self, forKey: "title")
        createdAt = try fields.decode(Instant.self, forKey: "createdAt")
        updatedAt = try fields.decode(Instant.self, forKey: "updatedAt")
    }

    public func encode(to encoder: any Encoder) throws {
        try encoder.encode(kind: TodoTaskKind.open) {
            try $0.encode(id, forKey: "id")
            try $0.encode(title, forKey: "title")
            try $0.encode(createdAt, forKey: "createdAt")
            try $0.encode(updatedAt, forKey: "updatedAt")
        }
    }
}

extension CompletedTask: Codable {
    public init(from decoder: any Decoder) throws {
        guard try decoder.kind(TodoTaskKind.self) == .completed else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "完了したタスクではない"))
        }
        let fields = try decoder.fields()
        id = try fields.decode(TaskId.self, forKey: "id")
        title = try fields.decode(TaskTitle.self, forKey: "title")
        createdAt = try fields.decode(Instant.self, forKey: "createdAt")
        updatedAt = try fields.decode(Instant.self, forKey: "updatedAt")
        completedAt = try fields.decode(Instant.self, forKey: "completedAt")
        completion = try fields.decode(TaskCompletion.self, forKey: "completion")
    }

    public func encode(to encoder: any Encoder) throws {
        try encoder.encode(kind: TodoTaskKind.completed) {
            try $0.encode(id, forKey: "id")
            try $0.encode(title, forKey: "title")
            try $0.encode(createdAt, forKey: "createdAt")
            try $0.encode(updatedAt, forKey: "updatedAt")
            try $0.encode(completedAt, forKey: "completedAt")
            try $0.encode(completion, forKey: "completion")
        }
    }
}

extension TodoTask: Codable {
    public init(from decoder: any Decoder) throws {
        switch try decoder.kind(TodoTaskKind.self) {
        case .open: self = .open(try OpenTask(from: decoder))
        case .completed: self = .completed(try CompletedTask(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .open(let task): try task.encode(to: encoder)
        case .completed(let task): try task.encode(to: encoder)
        }
    }
}
