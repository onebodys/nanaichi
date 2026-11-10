/// 個人情報（ジャーナル記入の本文など）を包む型（AGENTS.md「境界での検証と PII」、TS の `Sensitive`）。
///
/// `print`・文字列への埋め込み・`debugPrint`・`dump` のどれでも中身を伏せる。
/// TS の `Sensitive` は `toJSON` で伏せ字になるが、こちらは `Encodable` にしない。うっかり JSON にしようとすると
/// コンパイルが通らない。JSON に本文を書くのは、それを持つ型（`JournalEntry`）が `unwrap()` で取り出すときだけにする
public struct Sensitive<Value: Sendable>: Sendable {
    private let value: Value

    public init(_ value: Value) { self.value = value }

    public func unwrap() -> Value { value }
}

extension Sensitive: Equatable where Value: Equatable {}
extension Sensitive: Hashable where Value: Hashable {}

private let redacted = "[REDACTED]"

extension Sensitive: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String { redacted }
    public var debugDescription: String { redacted }
    /// `dump` と `Mirror` に中身を見せない
    public var customMirror: Mirror { Mirror(self, children: []) }
}
