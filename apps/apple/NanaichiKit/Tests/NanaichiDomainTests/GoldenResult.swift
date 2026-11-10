/// byethrow の Result を JSON にした形（`{ "kind": "Success", "value": … }` / `{ "kind": "Failure", "error": … }`）
struct GoldenResult<Value: Encodable, Failure: Error & Encodable>: Encodable {
    let result: Result<Value, Failure>

    init(_ result: Result<Value, Failure>) { self.result = result }

    private enum CodingKeys: String, CodingKey { case kind, value, error }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch result {
        case .success(let value):
            try container.encode("Success", forKey: .kind)
            try container.encode(value, forKey: .value)
        case .failure(let error):
            try container.encode("Failure", forKey: .kind)
            try container.encode(error, forKey: .error)
        }
    }
}

/// 検証に通らなかった（TS のテストが書き出す `{ "kind": "Invalid" }`）。Swift の検証は失敗できる `init?` なので、
/// nil をこの失敗として書く
struct Invalid: Error, Encodable {
    private enum CodingKeys: String, CodingKey { case kind }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("Invalid", forKey: .kind)
    }
}

extension GoldenResult where Failure == Invalid {
    init(parsed value: Value?) {
        self.init(value.map(Result.success) ?? .failure(Invalid()))
    }
}

/// 入力の値が検証に通らない（ゴールデンケースの入力が壊れている）
struct InvalidInput: Error { let description: String }

func parsed<T>(_ value: T?, _ description: String = "\(T.self)") throws -> T {
    guard let value else { throw InvalidInput(description: description) }
    return value
}
