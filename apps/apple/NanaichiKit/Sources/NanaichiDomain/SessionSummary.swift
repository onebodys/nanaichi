/// セッションのジャーナル記入の数。タイムラインを読み込むまでは数えられない。
/// 削除した記入は数えない（タイムラインに出ないため）
public enum EntryCount: Hashable, Sendable {
    case counted(Int)
    case notYetCounted
}

/// セッションのまとめ（GLOSSARY の「セッションのまとめ」）。終了した直後のタイマーに出す
public struct SessionSummary: Hashable, Sendable, Encodable {
    public let startedAt: Instant
    public let endedAt: Instant
    public let endedBy: EndedBy
    public let focusTimeMs: Int64
    public let completedSets: Int
    public let abortedSets: Int
    /// セットの結末を時刻の古い順に
    public let sets: [SetOutcome]
    public let entries: EntryCount

    /// 終了したセッションのまとめ。
    ///
    /// セットの並びは `now`（終了を知った今の時刻）で計算する。自動終了は最後の記入・操作の時刻で
    /// 閉じるので、その時刻で計算すると、まだ自動終了していない状態のセットの並びになってしまう
    public static func of(
        session: Session, ended: TimerState.Ended, now: Instant, entries: EntryCount
    ) -> SessionSummary {
        let sets = session.setOutcomesAt(now)
        return SessionSummary(
            startedAt: session.events.start.event.at, endedAt: ended.endedAt, endedBy: ended.endedBy,
            focusTimeMs: FocusTime.ofCompletedSets(ended.completedSets),
            completedSets: ended.completedSets,
            abortedSets: sets.count { $0.kind == .abortedSet }, sets: sets, entries: entries)
    }
}

extension EntryCount: Codable {
    private enum Kind: String, Codable {
        case counted = "Counted"
        case notYetCounted = "NotYetCounted"
    }

    public init(from decoder: any Decoder) throws {
        switch try decoder.kind(Kind.self) {
        case .counted: self = .counted(try decoder.fields().decode("count", atLeast: 0))
        case .notYetCounted: self = .notYetCounted
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .counted(let count):
            try encoder.encode(kind: Kind.counted) { try $0.encode(count, forKey: "count") }
        case .notYetCounted:
            try encoder.encode(kind: Kind.notYetCounted) { _ in }
        }
    }
}
