import Foundation
import GRDB
import NanaichiDomain

/// 自分で書いた行が読めない。記録が壊れているか実装の誤りで、想定内の失敗ではないので例外にする。
/// どの表のどの列かだけを持ち、値は持たない（ジャーナル記入の本文は PII）
struct UnreadableRecord: Error, CustomStringConvertible {
    let table: String
    let column: String

    var description: String { "\(table).\(column) を読めない" }
}

/// DB の行（境界）。列の値を検証し、その場でドメインの型にする。
/// GRDB の `row[column]` は型が合わないと止まるので、`DatabaseValue` で受けて確かめる
struct RowReader {
    let row: Row
    let table: String

    private func value(_ column: String) -> DatabaseValue {
        row[column] ?? .null
    }

    private func unreadable(_ column: String) -> UnreadableRecord {
        UnreadableRecord(table: table, column: column)
    }

    func optionalInteger(_ column: String) throws -> Int64? {
        switch value(column).storage {
        case .null: nil
        case .int64(let number): number
        case .double, .string, .blob: throw unreadable(column)
        }
    }

    func integer(_ column: String) throws -> Int64 {
        guard let number = try optionalInteger(column) else { throw unreadable(column) }
        return number
    }

    func optionalText(_ column: String) throws -> String? {
        switch value(column).storage {
        case .null: nil
        case .string(let text): text
        case .int64, .double, .blob: throw unreadable(column)
        }
    }

    func text(_ column: String) throws -> String {
        guard let text = try optionalText(column) else { throw unreadable(column) }
        return text
    }

    /// 検証つきで読む。`parse` が nil を返せば読めない
    func parsed<T>(_ column: String, _ parse: (String) -> T?) throws -> T {
        guard let parsed = parse(try text(column)) else { throw unreadable(column) }
        return parsed
    }

    func instant(_ column: String) throws -> Instant {
        Instant(milliseconds: try integer(column))
    }

    func optionalInstant(_ column: String) throws -> Instant? {
        try optionalInteger(column).map(Instant.init(milliseconds:))
    }

    func positiveInt(_ column: String) throws -> Int {
        guard let number = Int(exactly: try integer(column)), number >= 1 else { throw unreadable(column) }
        return number
    }

    func optionalPositiveInt(_ column: String) throws -> Int? {
        guard let raw = try optionalInteger(column) else { return nil }
        guard let number = Int(exactly: raw), number >= 1 else { throw unreadable(column) }
        return number
    }

    /// `json_group_array(name)` で1行に並べたタグ（つけた順）
    func tags(_ column: String) throws -> [TagName] {
        let names = try? JSONDecoder().decode([String].self, from: Data(try text(column).utf8))
        guard let tags = names.flatMap(Tags.parse) else { throw unreadable(column) }
        return tags
    }
}
