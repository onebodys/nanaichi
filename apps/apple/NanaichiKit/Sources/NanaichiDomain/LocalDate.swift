import Foundation

/// 端末のタイムゾーン（`Asia/Tokyo` のような IANA の名前）。外から受け取るので、知っている名前かを確かめる。
///
/// TS は `Intl.DateTimeFormat` で日付を求める。こちらは Foundation の `TimeZone` から UTC との差を読み、
/// `Instant` のミリ秒に足して暦の日付にする。どちらも時計も外部も読まず、同じ引数なら同じ結果を返すので
/// ドメインで使ってよい。名前は受け取った文字列のまま持つ（`TimeZone(identifier: "UTC").identifier` は
/// `GMT` になるので、`TimeZone` からは戻さない）
public struct TimeZoneName: Hashable, Sendable {
    public let identifier: String
    private let zone: TimeZone

    public init?(_ identifier: String) {
        guard let zone = TimeZone(identifier: identifier) else { return nil }
        self.identifier = identifier
        self.zone = zone
    }

    /// 時刻 `at` の、このタイムゾーンでの日付と、その日の 0:00 からの分
    public func localTime(at instant: Instant) -> LocalTime {
        let seconds = Double(instant.milliseconds) / 1000
        let offsetMs = Int64(zone.secondsFromGMT(for: Date(timeIntervalSince1970: seconds))) * 1000
        let local = instant.milliseconds + offsetMs
        let days = floorDiv(local, millisecondsPerDay)
        return LocalTime(
            date: LocalDate(dayNumber: Int(days)),
            minuteOfDay: Int((local - days * millisecondsPerDay) / 60_000))
    }

    public func localDate(at instant: Instant) -> LocalDate { localTime(at: instant).date }

    /// 日付 `date` が始まる時刻（その日の 0:00）。
    ///
    /// UTC の 0:00 から、タイムゾーンの差だけずらす。夏時間の切り替わりで、その日の前後で差が変わることがあるので、
    /// UTC の 0:00 での差と、ずらした先での差の両方で候補を作り、その日付に入るうち早いほうを選ぶ。
    /// 0:00 が夏時間で飛ぶ日は、その日の最初の時刻（1:00 など）になる（TS の `startOfDayIn` と同じ手順）
    public func startOfDay(_ date: LocalDate) -> Instant {
        func offsetMs(at ms: Int64) -> Int64 {
            (localTime(at: Instant(milliseconds: ms)).minuteNumber - floorDiv(ms, 60_000)) * 60_000
        }
        let midnightUtc = Int64(date.dayNumber) * millisecondsPerDay
        let first = midnightUtc - offsetMs(at: midnightUtc)
        let second = midnightUtc - offsetMs(at: first)
        let inDate = [first, second].filter { localDate(at: Instant(milliseconds: $0)) == date }
        return Instant(milliseconds: inDate.min() ?? max(first, second))
    }
}

extension TimeZoneName: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        guard let name = TimeZoneName(text) else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "タイムゾーンではない: \(text)")
        }
        self = name
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(identifier)
    }
}

/// 端末のタイムゾーンでの日付。暦の上の日付なので、計算はタイムゾーンに関わらない。
/// `key` は `YYYY-MM-DD` で、文字列の順が日付の順になる
public struct LocalDate: Hashable, Comparable, Sendable {
    public let year: Int
    public let month: Int
    public let day: Int

    /// 暦にある日付かは確かめない（暦の計算の結果か、JSON の検証を通ったものだけを作る）
    init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// 1970-01-01 からの日数（`dayNumber`）の日付
    init(dayNumber: Int) {
        let (year, month, day) = Instant.civilFromDays(Int64(dayNumber))
        self.init(year: Int(year), month: Int(month), day: Int(day))
    }

    /// `YYYY-MM-DD` と書いた日付（API のクエリ）。暦にない日付（2月30日など）は通さない
    public init?(key: String) {
        let parts = key.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
            parts.allSatisfy({ $0.utf8.allSatisfy { (48...57).contains($0) } }),
            let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
            (1...12).contains(month), (1...LocalDate.daysInMonth(year: year, month: month)).contains(day)
        else { return nil }
        self.init(year: year, month: month, day: day)
    }

    public var key: String { "\(pad(year, 4))-\(pad(month, 2))-\(pad(day, 2))" }

    public static func < (lhs: LocalDate, rhs: LocalDate) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }

    /// 1970-01-01 からの日数。日付の差や曜日を求めるのに使う
    public var dayNumber: Int {
        Int(Instant.daysFromCivil(year: Int64(year), month: Int64(month), day: Int64(day)))
    }

    /// 月曜を 0 とする曜日（1970-01-01 は木曜）
    public var weekdayFromMonday: Int { ((dayNumber + 3) % 7 + 7) % 7 }

    public func adding(days: Int) -> LocalDate { LocalDate(dayNumber: dayNumber + days) }

    public static func daysInMonth(year: Int, month: Int) -> Int {
        switch month {
        case 2: year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) ? 29 : 28
        case 4, 6, 9, 11: 30
        default: 31
        }
    }

    public static func firstOfMonth(year: Int, month: Int) -> LocalDate {
        LocalDate(year: year, month: month, day: 1)
    }
}

/// 端末のタイムゾーンでの日付と、その日の 0:00 からの分
public struct LocalTime: Hashable, Sendable {
    public let date: LocalDate
    public let minuteOfDay: Int

    /// 暦の上の分（1970-01-01 0:00 からの分）。タイムゾーンの差を求めるのに使う
    var minuteNumber: Int64 { Int64(date.dayNumber) * 1440 + Int64(minuteOfDay) }
}

func pad(_ value: Int, _ width: Int) -> String {
    let digits = String(value)
    return String(repeating: "0", count: max(0, width - digits.count)) + digits
}

/// JSON にした日付。`key` は年月日から作り直さず、年月日と合うかを確かめる（TS の `LocalDateJsonSchema`）
extension LocalDate: Codable {
    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        let key = try fields.decode(String.self, forKey: "key")
        let year = try fields.decode(Int.self, forKey: "year")
        let month = try fields.decode("month", atLeast: 1)
        let day = try fields.decode("day", atLeast: 1)
        self.init(year: year, month: month, day: day)
        guard month <= 12, day <= 31, key == self.key else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "日付として読めない: \(key)"))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: JSONKey.self)
        try container.encode(key, forKey: "key")
        try container.encode(year, forKey: "year")
        try container.encode(month, forKey: "month")
        try container.encode(day, forKey: "day")
    }
}
