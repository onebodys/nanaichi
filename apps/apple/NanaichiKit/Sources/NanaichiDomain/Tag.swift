/// タグの名前（GLOSSARY の「タグ」）。空白を含まない20文字まで。英字の大文字・小文字と全角・半角は区別しない
public struct TagName: Hashable, Sendable {
    public let rawValue: String

    /// 名前の長さの上限（書記素の数。絵文字も1文字と数える）
    static let maxLength = 20

    /// 入力されたタグの名前を、記録する形に寄せて検証する（ADR 0013）。
    ///
    /// NFKC で全角英数・記号を半角に寄せ、前後の空白と先頭の `#` を外し、英字を小文字にする。
    /// ひらがなとカタカナは NFKC でも寄らない
    public init?(_ input: String) {
        let trimmed = input.nfkc.jsTrimmed.unicodeScalars
        let name = String(trimmed.drop { $0 == "#" }).jsLowercased
        guard !name.isEmpty, name.count <= TagName.maxLength,
            !name.unicodeScalars.contains(where: \.isJSWhitespace)
        else { return nil }
        rawValue = name
    }
}

extension TagName: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        guard let name = TagName(text) else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "タグの名前として読めない: \(text)")
        }
        self = name
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// 1件の記入につけるタグ（TS の `Tags`）
public enum Tags {
    /// つけた順に並べ、同じ名前は1つにまとめる。使えるタグの種類の上限を超えてはつけられない
    public static func of(_ names: [TagName]) -> [TagName]? {
        let unique = names.uniqued()
        return unique.count <= Tag.kindsMax ? unique : nil
    }

    public static func parse(_ inputs: [String]) -> [TagName]? {
        var names: [TagName] = []
        for input in inputs {
            guard let name = TagName(input) else { return nil }
            names.append(name)
        }
        return of(names)
    }

    static func decode(_ fields: KeyedDecodingContainer<JSONKey>, forKey key: JSONKey) throws -> [TagName] {
        guard let tags = of(try fields.decode([TagName].self, forKey: key)) else {
            throw DecodingError.dataCorruptedError(
                forKey: key, in: fields, debugDescription: "タグが \(Tag.kindsMax) 種類より多い")
        }
        return tags
    }
}

/// 使えるタグの種類の上限を超える（GLOSSARY の「タグ」）
public struct TagLimitExceeded: Error, Hashable, Encodable {
    public let limit: Int

    private enum Kind: String { case tagLimitExceeded = "TagLimitExceeded" }

    public func encode(to encoder: any Encoder) throws {
        try encoder.encode(kind: Kind.tagLimitExceeded) { try $0.encode(limit, forKey: "limit") }
    }
}

public enum Tag {
    /// 1人が使えるタグの種類の上限（GLOSSARY の「タグ」）
    public static let kindsMax = 20

    /// 記入に `tags` をつけても、使っているタグの種類が上限を超えないことを確かめる。
    ///
    /// `inUse` はその記入以外の削除していない記入についているタグ。どの記入にもついていない
    /// タグは存在しないので数えない（ADR 0013）
    public static func ensureWithinLimit(inUse: [TagName], tags: [TagName])
        -> Result<[TagName], TagLimitExceeded>
    {
        Set(inUse + tags).count > kindsMax ? .failure(TagLimitExceeded(limit: kindsMax)) : .success(tags)
    }

    /// 新しいタグ `name` を作れるか（つけているもの・使っているものなら作るのではないので、いつでもつけられる）
    public static func canAdd(inUse: [TagName], attached: [TagName], name: TagName) -> Bool {
        switch ensureWithinLimit(inUse: inUse, tags: attached + [name]) {
        case .success: true
        case .failure: false
        }
    }
}

/// 使っているタグの一覧（`GET /api/tags`）。最近使った順（ADR 0013）
public struct TagList: Hashable, Sendable, Codable {
    public let tags: [TagName]

    public init(tags: [TagName]) { self.tags = tags }
}

/// 使っているタグと、それがついている削除していない記入の数
public struct TagUsage: Hashable, Sendable, Codable {
    public let name: TagName
    public let entryCount: Int

    public init(name: TagName, entryCount: Int) {
        self.name = name
        self.entryCount = entryCount
    }

    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        name = try fields.decode(TagName.self, forKey: "name")
        entryCount = try fields.decode("entryCount", atLeast: 1)
    }
}

/// 使っているタグとその記入の数の一覧（`GET /api/tags/usage`）。最近使った順（ADR 0013）
public struct TagUsageList: Hashable, Sendable, Codable {
    public let tags: [TagUsage]

    public init(tags: [TagUsage]) { self.tags = tags }
}

/// タグを削除するときに、そのタグがついている記入をどうするか（GLOSSARY の「タグの削除」、ADR 0017）
public enum TagDeletion: Hashable, Sendable {
    /// タグを外すだけ
    case detach
    /// 使っている別のタグ `to` に付け替える
    case reassign(to: TagName)
}

extension TagDeletion: Codable {
    private enum Kind: String, Codable {
        case detach = "Detach"
        case reassign = "Reassign"
    }

    public init(from decoder: any Decoder) throws {
        switch try decoder.kind(Kind.self) {
        case .detach: self = .detach
        case .reassign: self = .reassign(to: try decoder.fields().decode(TagName.self, forKey: "to"))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .detach: try encoder.encode(kind: Kind.detach) { _ in }
        case .reassign(let to): try encoder.encode(kind: Kind.reassign) { try $0.encode(to, forKey: "to") }
        }
    }
}

/// タグを削除できない
public enum DeleteTagRejected: Error, Hashable {
    /// 削除するタグか付け替え先のタグが、削除していない記入のどれにもついていない（存在しない）
    case tagNotFound(name: TagName)
    /// 付け替え先が、削除するタグ自身
    case reassignToSameTag
}

extension DeleteTagRejected: Encodable {
    private enum Kind: String {
        case tagNotFound = "TagNotFound"
        case reassignToSameTag = "ReassignToSameTag"
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .tagNotFound(let name):
            try encoder.encode(kind: Kind.tagNotFound) { try $0.encode(name, forKey: "name") }
        case .reassignToSameTag: try encoder.encode(kind: Kind.reassignToSameTag) { _ in }
        }
    }
}

/// 削除したタグ `name` と、ついていた記入をどうしたか
public struct DeletedTag: Hashable, Sendable, Codable {
    public let name: TagName
    public let deletion: TagDeletion

    public init(name: TagName, deletion: TagDeletion) {
        self.name = name
        self.deletion = deletion
    }

    /// タグ `name` を削除できるかを確かめる。削除するタグも付け替え先も、使っているタグ `inUse` の
    /// どれかでなければならない（付け替え先は使っているタグから選ぶ。GLOSSARY の「タグの削除」）
    public func ensureDeletable(inUse: [TagName]) -> Result<DeletedTag, DeleteTagRejected> {
        func ensureInUse(_ name: TagName) -> Result<Void, DeleteTagRejected> {
            inUse.contains(name) ? .success(()) : .failure(.tagNotFound(name: name))
        }
        switch deletion {
        case .detach:
            return ensureInUse(name).map { self }
        case .reassign(let to):
            if to == name { return .failure(.reassignToSameTag) }
            return ensureInUse(name).flatMap { ensureInUse(to) }.map { self }
        }
    }

    /// 1件の記入のタグ `tags` から、削除したタグを外す（付け替えるなら付け替え先に置き換える）。
    /// 付け替え先がすでについていれば、先にあった位置の1つにまとめる
    public func apply(to tags: [TagName]) -> [TagName] {
        switch deletion {
        case .detach: tags.filter { $0 != name }
        case .reassign(let to): tags.map { $0 == name ? to : $0 }.uniqued()
        }
    }
}

extension Array where Element: Hashable {
    /// 同じものは最初に現れた位置の1つにまとめる（TS の `[...new Set(xs)]`）
    func uniqued() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}

// MARK: - 読み書きの契約

/// 使っているタグを読む契約。どちらも削除していない記入についているタグを、最近使った順
/// （最後に書いた時刻の新しい順、同じなら名前の UTF-8 のバイト順）に返す
public protocol TagStore {
    func listTagsInUse() throws -> [TagName]
    func listTagUsage() throws -> [TagUsage]
}
