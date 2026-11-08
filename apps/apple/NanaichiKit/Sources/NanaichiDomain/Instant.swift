/// ドメインの時刻。UNIX エポックからのミリ秒で持つ。
///
/// `Date` は秒を浮動小数点で持つので、ISO 8601 のミリ秒と行き来させると端数がずれることがある。
/// TS のドメインと同じくミリ秒の整数で計算し、`Date` への変換は画面と記録先（Imperative Shell）で行う。
public struct Instant: Hashable, Comparable, Sendable {
    public let milliseconds: Int64

    public init(milliseconds: Int64) {
        self.milliseconds = milliseconds
    }

    public static func < (lhs: Instant, rhs: Instant) -> Bool {
        lhs.milliseconds < rhs.milliseconds
    }

    public func adding(milliseconds delta: Int64) -> Instant {
        Instant(milliseconds: milliseconds + delta)
    }

    public func milliseconds(since other: Instant) -> Int64 {
        milliseconds - other.milliseconds
    }
}
