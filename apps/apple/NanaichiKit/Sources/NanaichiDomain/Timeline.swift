/// タイムラインに並べる1つのセッション。`entries` は削除していない記入（順は問わない）
public struct TimelineSession: Hashable, Sendable, Codable {
    public let session: Session
    public let entries: [JournalEntry]

    public init(session: Session, entries: [JournalEntry]) {
        self.session = session
        self.entries = entries
    }

    var startedAt: Instant { session.events.start.event.at }
}

/// 次のページ（TS の `TimelineCursor` と `TaggedEntriesCursor`。形が同じなので1つにする）。
/// `before` はこのページでいちばん古いもの（セッションの開始時刻か、記入を書いた時刻）
public enum PageCursor: Hashable, Sendable {
    case more(before: Instant)
    /// これより古いものはない
    case end
}

/// タイムラインの1ページ（`GET /api/timeline` の応答、ADR 0011）。
///
/// 開始時刻が新しい順のセッションと、そのセッションの記入。日付の区切りと完了セット数は
/// 端末のタイムゾーンで決まるので、ここでは決めず、画面が `Timeline.build` で組み立てる。
/// 進行中のセッションの完了セット数を計算できるよう、サーバーの時刻を持つ
public struct TimelinePage: Hashable, Sendable, Codable {
    public let serverTime: Instant
    public let sessions: [TimelineSession]
    public let next: PageCursor
}

/// 日付の区切りに出す、その日の完了セット数。
///
/// まだ読み込んでいない古いセッションがあると、読み込んだうちでいちばん古いセッションが始まった日は
/// 数が確定しない（ADR 0011）。その日は `notYetCounted` にし、続きを読み込んでから数える
public enum DayCompletedSets: Hashable, Sendable {
    case counted(Int)
    case notYetCounted
}

/// ある日付の中の、1つのセッションの区切りとその日に書いた記入（新しい順）。
/// `completedSets` はそのセッションがその日に完了したセットの数（集中を終えた時刻の日付で数える）
public struct TimelineDaySession: Hashable, Sendable, Codable {
    public let sessionId: SessionId
    public let startedAt: Instant
    public let completedSets: Int
    public let entries: [JournalEntry]
}

public struct TimelineDay: Hashable, Sendable, Codable {
    public let date: LocalDate
    public let completedSets: DayCompletedSets
    /// 開始時刻が新しい順
    public let sessions: [TimelineDaySession]
}

/// 1つのセッションが、ある日付に持つもの
private struct SessionOnDay {
    let date: LocalDate
    let daySession: TimelineDaySession
}

/// 1つのセッションを日付ごとに分ける。セッションが 0:00 をまたげば、両方の日付に区切りが出る。
///
/// セッションが現れる日付は、始まった日・記入を書いた日・完了セットになった日のどれか。
/// 記入のないセッションも、始まった日には区切りが出る
private func splitByDay(_ item: TimelineSession, now: Instant, timeZone: TimeZoneName) -> [SessionOnDay] {
    let completedSetDates = item.session.completedSetTimesAt(now).map(timeZone.localDate)
    let entriesWithDate = item.entries.map { (entry: $0, date: timeZone.localDate(at: $0.writtenAt)) }
    let dates = ([timeZone.localDate(at: item.startedAt)] + entriesWithDate.map(\.date) + completedSetDates)
        .uniqued()
    return dates.map { date in
        SessionOnDay(
            date: date,
            daySession: TimelineDaySession(
                sessionId: item.session.id, startedAt: item.startedAt,
                completedSets: completedSetDates.count { $0 == date },
                entries: entriesWithDate.filter { $0.date == date }.map(\.entry)
                    .sorted { $0.writtenAt > $1.writtenAt }))
    }
}

public enum Timeline {
    /// 1ページに含めるセッションの数（ADR 0011）
    public static let pageSize = 10

    /// 読み込んだセッションから、ある時刻のタイムライン（GLOSSARY の「タイムライン」）を組み立てる。
    ///
    /// - 日付はタイムゾーン `timeZone`（端末のタイムゾーン）の 0:00 で区切る
    /// - 日付・セッション・記入のどれも新しい順
    /// - 日付の完了セット数は、集中を終えた時刻がその日付の完了セットを数える。進行中のセッションは
    ///   `now` までに完了したものを数える
    /// - `next` が `more` なら、いちばん古いセッションが始まった日は数が確定しない
    public static func build(
        sessions: [TimelineSession], next: PageCursor, now: Instant, timeZone: TimeZoneName
    ) -> [TimelineDay] {
        let uncounted: LocalDate? =
            switch next {
            case .end: nil
            case .more: sessions.map(\.startedAt).min().map(timeZone.localDate)
            }
        let onDays = sessions.flatMap { splitByDay($0, now: now, timeZone: timeZone) }
        return onDays.map(\.date).uniqued().sorted(by: >).map { date in
            let onDate = onDays.filter { $0.date == date }
            return TimelineDay(
                date: date,
                completedSets: date == uncounted
                    ? .notYetCounted : .counted(onDate.reduce(0) { $0 + $1.daySession.completedSets }),
                sessions: onDate.map(\.daySession).sorted { $0.startedAt > $1.startedAt })
        }
    }

    /// 時刻 `now` の日付（タイムゾーン `timeZone`）の完了セット数。ヘッダーに出す今日の集中時間のもと。
    ///
    /// 組み立てたタイムラインにその日付がなければ、その日にはまだ完了セットがない。セッションは
    /// 開始の新しい順に読み込むので、今日の完了セットを持つセッションは必ず最新のページに入っている
    public static func completedSetsOn(_ days: [TimelineDay], now: Instant, timeZone: TimeZoneName)
        -> DayCompletedSets
    {
        let today = timeZone.localDate(at: now)
        return days.first { $0.date == today }?.completedSets ?? .counted(0)
    }

    /// 数が確定しない日付の区切りに、ほかで数えた完了セット数を入れる。
    ///
    /// 1日に1ページより多くセッションがあると、今日の区切りの数が確定しない（ADR 0011）。
    /// 今日の数はスタッツ（ADR 0014）で数えられるので、それを入れる。確定している日はそのまま
    public static func withDayCounted(_ days: [TimelineDay], date: LocalDate, count: Int) -> [TimelineDay] {
        days.map { day in
            guard day.date == date, day.completedSets == .notYetCounted else { return day }
            return TimelineDay(date: day.date, completedSets: .counted(count), sessions: day.sessions)
        }
    }

    /// セッションに書いた記入の数（削除したものを除く）。日付をまたいだセッションは、すべての日付の分を足す
    public static func entryCountOf(_ days: [TimelineDay], sessionId: SessionId) -> Int {
        days.flatMap(\.sessions).filter { $0.sessionId == sessionId }.reduce(0) { $0 + $1.entries.count }
    }

    /// 読み込んだ記録 `b` を `a` に重ねる。同じセッションは `b` で置き換え、開始時刻が新しい順に並べる
    public static func merge(_ a: [TimelineSession], _ b: [TimelineSession]) -> [TimelineSession] {
        let ids = Set(b.map(\.session.id))
        return (a.filter { !ids.contains($0.session.id) } + b).sorted { $0.startedAt > $1.startedAt }
    }

    /// 現在のセッション（タイマーのスナップショット）をタイムラインに重ねる。
    ///
    /// 操作イベントはタイマーのほうが新しいので、それで置き換える。記入はタイムラインのものを残す
    public static func withCurrentSession(_ sessions: [TimelineSession], current: Session)
        -> [TimelineSession]
    {
        let entries = sessions.first { $0.session.id == current.id }?.entries ?? []
        return merge(sessions, [TimelineSession(session: current, entries: entries)])
    }

    /// 書いた・編集した記入を、そのセッションに入れる（同じ ID なら置き換える）
    public static func putEntry(_ sessions: [TimelineSession], _ entry: JournalEntry) -> [TimelineSession] {
        sessions.map { item in
            guard item.session.id == entry.sessionId else { return item }
            return TimelineSession(
                session: item.session, entries: item.entries.filter { $0.id != entry.id } + [entry])
        }
    }

    /// 削除した記入を取り除く
    public static func removeEntry(_ sessions: [TimelineSession], id: JournalEntryId) -> [TimelineSession] {
        sessions.map { TimelineSession(session: $0.session, entries: $0.entries.filter { $0.id != id }) }
    }

    /// 削除したタグを、読み込んだすべての記入から外す（付け替えるなら付け替え先に置き換える）。
    /// サーバーが記録に当てたのと同じ関数で、手元の記入にも当てる（ADR 0017）
    public static func deleteTag(_ sessions: [TimelineSession], _ deleted: DeletedTag) -> [TimelineSession] {
        sessions.map {
            TimelineSession(session: $0.session, entries: $0.entries.map { $0.deletingTag(deleted) })
        }
    }

    /// 記録から読んだセッションを1ページにする。`found` は `limit + 1` 件まで読んだもので、
    /// `limit` を超えていれば次のページがある
    public static func page(found: [TimelineSession], limit: Int, serverTime: Instant) -> TimelinePage {
        let sessions = Array(found.prefix(limit))
        guard found.count > limit, let oldest = sessions.last else {
            return TimelinePage(serverTime: serverTime, sessions: sessions, next: .end)
        }
        return TimelinePage(serverTime: serverTime, sessions: sessions, next: .more(before: oldest.startedAt))
    }
}

// MARK: - JSON（API の応答と同じ形。ADR 0009）

extension PageCursor: Codable {
    private enum Kind: String, Codable {
        case more = "More"
        case end = "End"
    }

    public init(from decoder: any Decoder) throws {
        switch try decoder.kind(Kind.self) {
        case .more: self = .more(before: try decoder.fields().decode(Instant.self, forKey: "before"))
        case .end: self = .end
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .more(let before):
            try encoder.encode(kind: Kind.more) { try $0.encode(before, forKey: "before") }
        case .end: try encoder.encode(kind: Kind.end) { _ in }
        }
    }
}

extension DayCompletedSets: Codable {
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
        case .notYetCounted: try encoder.encode(kind: Kind.notYetCounted) { _ in }
        }
    }
}

// MARK: - 読み書きの契約

/// タイムラインに読む範囲。次のページがあるかを見分けるため、`limit` は1ページより1件多くする
public enum TimelineRange: Hashable, Sendable {
    case latest(limit: Int)
    case before(Instant, limit: Int)
}

/// タイムラインのセッションを、開始時刻の新しい順に読む契約。記入は削除していないものを書いた順に
public protocol TimelineStore {
    func findTimelineSessions(_ range: TimelineRange) throws -> [TimelineSession]
}
