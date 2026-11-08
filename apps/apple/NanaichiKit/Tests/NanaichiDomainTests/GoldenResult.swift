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
