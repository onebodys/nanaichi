import Foundation
import NanaichiDomain

// タグの入力欄の候補と、入力欄でつけたままのタグ（Web の tag-options.ts と attached-tags.ts）

/// タグの入力欄に出す候補の1つ
public enum TagOption: Hashable, Sendable {
    /// 使っているタグ
    case existing(TagName)
    /// 入力した名前で新しく作るタグ。使えるタグの種類の上限に達していれば作れない
    case new(TagName, creatable: Bool)

    public var name: TagName {
        switch self {
        case .existing(let name), .new(let name, _): name
        }
    }

    /// つけられるか（作れない新しいタグはつけられない）
    public var attachable: Bool {
        switch self {
        case .existing: true
        case .new(_, let creatable): creatable
        }
    }
}

/// 入力が名前の規則に合わないときに出す案内
public enum TagInputHint: Hashable, Sendable {
    case none
    case invalid
}

public struct TagOptions: Hashable, Sendable {
    public let options: [TagOption]
    public let hint: TagInputHint
}

/// 入力中の文字列 `query` から、タグの入力欄に出す候補を決める（GLOSSARY の「タグ」）。
///
/// - 使っているタグ（`known`、最近使った順）を優先して出す。入力があれば、名前の規則で寄せた入力を含むものだけ
/// - 入力が使っているタグのどれとも一致しなければ、最後に「新しく作る」を出す
/// - 入力が名前の規則に合わなければ（空白を含む・長すぎる）、候補は出さずに案内を出す
///
/// `known` には入力欄でつけたまま、まだ書いていないタグが含まれないことがあるので、つけているタグ（`attached`）も候補に含める
public func tagOptionsOf(query: String, known: [TagName], attached: [TagName]) -> TagOptions {
    var seen = Set<TagName>()
    let candidates = (known + attached).filter { seen.insert($0).inserted }
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.drop(while: { $0 == "#" || $0 == "＃" }).isEmpty {
        return TagOptions(options: candidates.map(TagOption.existing), hint: .none)
    }
    guard let name = TagName(query) else { return TagOptions(options: [], hint: .invalid) }
    let matches = candidates.filter { $0.rawValue.contains(name.rawValue) }.map(TagOption.existing)
    if candidates.contains(name) { return TagOptions(options: matches, hint: .none) }
    return TagOptions(
        options: matches + [.new(name, creatable: Tag.canAdd(inUse: known, attached: attached, name: name))],
        hint: .none)
}

/// 候補の表示。新しく作るものと、作れないものはそうとわかるようにする
public func tagOptionTextOf(_ option: TagOption) -> String {
    switch option {
    case .existing(let name): tagTextOf(name)
    case .new(let name, let creatable):
        creatable ? "\(tagTextOf(name)) を新しく作る" : "\(tagTextOf(name)) は作れません（タグは\(Tag.kindsMax)種類まで）"
    }
}

/// 入力が規則に合わないときの案内
public let invalidTagNameHint = "タグの名前は空白を含まない20文字までです"

/// 入力欄でつけたままのタグ（GLOSSARY の「タグ」）。外すかセッションが終わるまで、続けて書く記入につく。
/// 端末ごとに覚える（ADR 0013）
public enum AttachedTags: Hashable, Sendable {
    /// セッションの外でつけたタグ。これからやることとして準備しておき、次に始めるセッションに持ち越す
    case prepared([TagName])
    /// セッション `sessionId` でつけている（準備したまま始めたものも含む）タグ
    case inSession(SessionId, [TagName])

    public static let none = AttachedTags.prepared([])

    public var tags: [TagName] {
        switch self {
        case .prepared(let tags), .inSession(_, let tags): tags
        }
    }

    /// 今のセッション `sessionId`（なければ nil）でつけたままのタグ。
    /// セッションでつけたタグは、そのセッションのあいだだけつく
    public func attached(in sessionId: SessionId?) -> [TagName] {
        switch self {
        case .prepared(let tags): tags
        case .inSession(let attachedTo, let tags): attachedTo == sessionId ? tags : []
        }
    }

    /// 今のセッションでタグを `tags` にしたときに覚える値。セッションの外なら準備したタグになる
    public static func attaching(_ tags: [TagName], in sessionId: SessionId?) -> AttachedTags {
        sessionId.map { .inSession($0, tags) } ?? .prepared(tags)
    }

    /// セッションの中で準備したタグを見たら、このセッションのタグとして覚え直す（終わったら外れるように）。
    /// 覚え直すものがなければ nil
    public func adopted(by sessionId: SessionId?) -> AttachedTags? {
        guard let sessionId, case .prepared(let tags) = self, !tags.isEmpty else { return nil }
        return .inSession(sessionId, tags)
    }

    /// タグを削除したら、つけたままのタグからも外す（付け替えたなら付け替え先に置き換える、ADR 0017）
    public func deletingTag(_ deleted: DeletedTag) -> AttachedTags {
        switch self {
        case .prepared(let tags): .prepared(deleted.apply(to: tags))
        case .inSession(let sessionId, let tags): .inSession(sessionId, deleted.apply(to: tags))
        }
    }

    /// 覚えておいた JSON（Web の localStorage と同じ形）を戻す。読めなければ何もついていない
    public static func parse(_ stored: Data?) -> AttachedTags {
        guard let stored, let parsed = try? JSONDecoder().decode(AttachedTags.self, from: stored) else { return .none }
        return parsed
    }

    public func serialized() -> Data {
        // 文字列と配列だけの値なので、JSON にできないことはない
        (try? JSONEncoder().encode(self)) ?? Data()
    }
}

extension AttachedTags: Codable {
    private enum Kind: String, Codable {
        case prepared = "Prepared"
        case inSession = "InSession"
    }

    private enum CodingKeys: String, CodingKey {
        case kind, sessionId, tags
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let tags = Tags.of(try container.decode([TagName].self, forKey: .tags)) else {
            throw DecodingError.dataCorruptedError(forKey: .tags, in: container, debugDescription: "タグが多すぎる")
        }
        switch try container.decode(Kind.self, forKey: .kind) {
        case .prepared: self = .prepared(tags)
        case .inSession: self = .inSession(try container.decode(SessionId.self, forKey: .sessionId), tags)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .prepared(let tags):
            try container.encode(Kind.prepared, forKey: .kind)
            try container.encode(tags, forKey: .tags)
        case .inSession(let sessionId, let tags):
            try container.encode(Kind.inSession, forKey: .kind)
            try container.encode(sessionId, forKey: .sessionId)
            try container.encode(tags, forKey: .tags)
        }
    }
}
