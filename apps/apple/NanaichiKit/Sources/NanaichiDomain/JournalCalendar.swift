/// ジャーナルのカレンダー（GLOSSARY）に出す月
public struct JournalMonth: Hashable, Sendable {
    public let year: Int
    public let month: Int

    public init?(year: Int, month: Int) {
        guard (1...12).contains(month) else { return nil }
        self.year = year
        self.month = month
    }

    private init(validYear year: Int, month: Int) {
        self.year = year
        self.month = month
    }

    /// 前の月・次の月
    public var before: JournalMonth {
        month == 1
            ? JournalMonth(validYear: year - 1, month: 12) : JournalMonth(validYear: year, month: month - 1)
    }

    public var after: JournalMonth {
        month == 12
            ? JournalMonth(validYear: year + 1, month: 1) : JournalMonth(validYear: year, month: month + 1)
    }

    /// API のクエリに書く月（`2026-10`）
    public var key: String { "\(pad(year, 4))-\(pad(month, 2))" }

    var first: LocalDate { LocalDate.firstOfMonth(year: year, month: month) }

    var last: LocalDate { first.adding(days: LocalDate.daysInMonth(year: year, month: month) - 1) }
}

/// 1日の記入の数。今日より後の日は、まだ来ていない日として分ける
public enum JournalCalendarDay: Hashable, Sendable {
    case day(date: LocalDate, entries: Int)
    case upcoming(date: LocalDate)
}

/// ジャーナルのカレンダー（GLOSSARY、`GET /api/journal-calendar` の応答）。
/// `days` はその月の1日から末日まで。画面はこれを月曜始まりの週に並べる
public struct JournalCalendar: Hashable, Sendable, Codable {
    public let month: JournalMonth
    public let today: LocalDate
    public let days: [JournalCalendarDay]
}

/// 選んだ日の記入（`GET /api/journal-entries/by-date` の応答）。書いた順
public struct EntriesOnDate: Hashable, Sendable, Codable {
    public let date: LocalDate
    public let entries: [JournalEntry]
}

/// 記入を書いた時刻の範囲。`from` を含み `until` を含まない
public struct WrittenWindow: Hashable, Sendable, Encodable {
    public let from: Instant
    public let until: Instant

    /// 日付 `first` から `last` までの記入を含む範囲。
    ///
    /// 端末のタイムゾーンでの日付は、UTC との差が -12〜+14 時間なので、UTC の暦でその前後1日まで
    /// 広げて読めば必ず含まれる。読んだあとで、端末のタイムゾーンでの日付で絞る
    init(first: LocalDate, last: LocalDate) {
        from = Instant(milliseconds: Int64(first.dayNumber - 1) * millisecondsPerDay)
        until = Instant(milliseconds: Int64(last.dayNumber + 2) * millisecondsPerDay)
    }

    init(from: Instant, until: Instant) {
        self.from = from
        self.until = until
    }
}

extension JournalCalendar {
    /// 月 `month` の記入をすべて含む、読む範囲
    public static func window(of month: JournalMonth) -> WrittenWindow {
        WrittenWindow(first: month.first, last: month.last)
    }

    /// 日 `date` の記入をすべて含む、読む範囲
    public static func window(of date: LocalDate) -> WrittenWindow {
        WrittenWindow(first: date, last: date)
    }

    /// 月 `month` の日ごとの記入の数を数える（GLOSSARY「ジャーナルのカレンダー」）。
    ///
    /// `writtenAts` は削除していない記入を書いた時刻で、月の外のものが混じっていてもよい。
    /// 記入は書いた時刻の、タイムゾーン `timeZone`（端末のタイムゾーン）での日付に数える
    public static func of(month: JournalMonth, writtenAts: [Instant], now: Instant, timeZone: TimeZoneName)
        -> JournalCalendar
    {
        let today = timeZone.localDate(at: now)
        let counts = writtenAts.reduce(into: [LocalDate: Int]()) { counts, writtenAt in
            counts[timeZone.localDate(at: writtenAt), default: 0] += 1
        }
        let days = (0..<LocalDate.daysInMonth(year: month.year, month: month.month)).map { offset in
            let date = month.first.adding(days: offset)
            return date > today
                ? JournalCalendarDay.upcoming(date: date) : .day(date: date, entries: counts[date] ?? 0)
        }
        return JournalCalendar(month: month, today: today, days: days)
    }

    /// 記入 `entries` のうち、タイムゾーン `timeZone` で日付 `date` に書いたものを、書いた順に並べる。
    /// `entries` は日付の前後のものが混じっていてもよい（`window(of: date)` で読んだもの）
    public static func entriesOn(_ date: LocalDate, entries: [JournalEntry], timeZone: TimeZoneName)
        -> EntriesOnDate
    {
        EntriesOnDate(
            date: date,
            entries: entries.filter { timeZone.localDate(at: $0.writtenAt) == date }.sorted {
                $0.writtenAt < $1.writtenAt
            })
    }
}

// MARK: - JSON（API の応答と同じ形。ADR 0009）

extension JournalMonth: Codable {
    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        let month = try fields.decode("month", atLeast: 1)
        guard let value = JournalMonth(year: try fields.decode(Int.self, forKey: "year"), month: month) else {
            throw DecodingError.dataCorruptedError(
                forKey: "month", in: fields, debugDescription: "月ではない: \(month)")
        }
        self = value
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: JSONKey.self)
        try container.encode(year, forKey: "year")
        try container.encode(month, forKey: "month")
    }
}

extension JournalCalendarDay: Codable {
    private enum Kind: String, Codable {
        case day = "Day"
        case upcoming = "Upcoming"
    }

    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        let date = try fields.decode(LocalDate.self, forKey: "date")
        switch try decoder.kind(Kind.self) {
        case .day: self = .day(date: date, entries: try fields.decode("entries", atLeast: 0))
        case .upcoming: self = .upcoming(date: date)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .day(let date, let entries):
            try encoder.encode(kind: Kind.day) {
                try $0.encode(date, forKey: "date")
                try $0.encode(entries, forKey: "entries")
            }
        case .upcoming(let date):
            try encoder.encode(kind: Kind.upcoming) { try $0.encode(date, forKey: "date") }
        }
    }
}
