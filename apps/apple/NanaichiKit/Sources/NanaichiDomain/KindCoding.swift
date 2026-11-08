/// JSON のキー。TS の判別可能な union と同じく、`kind` と中身のフィールドを1つのオブジェクトに並べる
struct JSONKey: CodingKey, ExpressibleByStringLiteral {
    let stringValue: String
    init(stringValue: String) { self.stringValue = stringValue }
    init(stringLiteral value: String) { stringValue = value }
    var intValue: Int? { nil }
    init?(intValue: Int) { nil }
}

extension Decoder {
    /// `kind` を読む。知らない種類なら読めない
    func kind<Kind: RawRepresentable<String> & Decodable>(_: Kind.Type) throws -> Kind {
        try fields().decode(Kind.self, forKey: "kind")
    }

    func fields() throws -> KeyedDecodingContainer<JSONKey> {
        try container(keyedBy: JSONKey.self)
    }
}

extension KeyedDecodingContainer<JSONKey> {
    /// `minimum` 以上の整数（セット番号やラウンドは 1 から、セット数や残り秒数は 0 から）
    func decode(_ key: JSONKey, atLeast minimum: Int) throws -> Int {
        let value = try decode(Int.self, forKey: key)
        guard value >= minimum else {
            throw DecodingError.dataCorruptedError(
                forKey: key, in: self, debugDescription: "\(minimum) 以上でない: \(value)")
        }
        return value
    }
}

extension Encoder {
    /// `kind` と `payload` のフィールドを同じオブジェクトに書く
    func encode(kind: some RawRepresentable<String>, _ payload: some Encodable) throws {
        try payload.encode(to: self)
        try encode(kind: kind) { _ in }
    }

    func encode(
        kind: some RawRepresentable<String>,
        fields: (inout KeyedEncodingContainer<JSONKey>) throws -> Void
    ) throws {
        var container = container(keyedBy: JSONKey.self)
        try container.encode(kind.rawValue, forKey: "kind")
        try fields(&container)
    }
}
