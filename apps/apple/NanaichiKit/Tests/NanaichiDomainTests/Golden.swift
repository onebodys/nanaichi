import Foundation
import Synchronization
import Testing

/// TS のテストが書き出したゴールデンケース（`fixtures/golden/`、ADR 0015）
let goldenDirectory = URL(filePath: #filePath)
    .deletingLastPathComponent()
    .appending(path: "../../../../../fixtures/golden")
    .standardized

/// JSON の値。期待する出力は型に戻さず、この形のまま実装の出力と比べる（TS の `goldenCases` と同じ）
enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// 小数は2進の浮動小数点なので、誤差を許して比べる（fixtures/golden/README.md）
    func matches(_ other: JSONValue) -> Bool {
        switch (self, other) {
        case (.number(let a), .number(let b)):
            return abs(a - b) <= 1e-9 * max(1, abs(a), abs(b))
        case (.array(let a), .array(let b)):
            return a.count == b.count && zip(a, b).allSatisfy { $0.matches($1) }
        case (.object(let a), .object(let b)):
            return a.keys == b.keys && a.allSatisfy { key, value in b[key].map(value.matches) ?? false }
        default:
            return self == other
        }
    }
}

struct GoldenCase: Sendable, CustomTestStringConvertible {
    let function: String
    let name: String
    let input: Data
    let expected: JSONValue

    var testDescription: String { name }
}

private struct GoldenFile: Decodable {
    let function: String
    let cases: [RawCase]

    struct RawCase: Decodable {
        let name: String
        let input: JSONValue
        let expected: JSONValue
    }
}

/// テストの引数として読んだゴールデンケースの関数。Swift Testing はテストを走らせる前にすべての引数を読む
private let loadedFunctions = Mutex<Set<String>>([])

enum Golden {
    static func cases(_ function: String) -> [GoldenCase] {
        loadedFunctions.withLock { _ = $0.insert(function) }
        let url = goldenDirectory.appending(path: "\(function).json")
        do {
            let file = try JSONDecoder().decode(GoldenFile.self, from: Data(contentsOf: url))
            return try file.cases.map { raw in
                GoldenCase(
                    function: file.function, name: raw.name,
                    input: try JSONEncoder().encode(raw.input), expected: raw.expected)
            }
        } catch {
            fatalError("ゴールデンケースを読めない: \(url.path) \(error)")
        }
    }

    /// 入力を `Input` に戻して `run` に通し、出力を JSON にして期待する出力と比べる
    static func check<Input: Decodable, Output: Encodable>(
        _ golden: GoldenCase, _ input: Input.Type, run: (Input) throws -> Output,
        sourceLocation: SourceLocation = #_sourceLocation
    ) throws {
        let decoded = try JSONDecoder().decode(Input.self, from: golden.input)
        let output = try JSONDecoder().decode(
            JSONValue.self, from: JSONEncoder().encode(try run(decoded)))
        #expect(
            output.matches(golden.expected),
            "\(golden.function): \(golden.name)\n実際: \(output)\n期待: \(golden.expected)",
            sourceLocation: sourceLocation)
    }

    static var loaded: Set<String> { loadedFunctions.withLock { $0 } }

    static var allFunctions: [String] {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: goldenDirectory.path)) ?? []
        return files.filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
    }
}
