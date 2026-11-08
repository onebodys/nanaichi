/// JSON では ISO 8601 の UTC の文字列（`2026-10-17T00:07:00.000Z`、TS の `Date.prototype.toISOString`）にする。
/// `Date` を通さずにミリ秒と文字列を直接行き来させ、端数がずれないようにする。
extension Instant: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        guard let instant = Instant(iso8601: text) else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "ISO 8601 の時刻として読めない: \(text)")
        }
        self = instant
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(iso8601)
    }
}

let millisecondsPerDay: Int64 = 86_400_000

extension Instant {
    /// `YYYY-MM-DDTHH:MM:SS(.sss)?Z` を読む。タイムゾーンは `Z` だけ受け付ける
    public init?(iso8601 text: String) {
        let chars = Array(text.utf8)
        func number(_ range: Range<Int>) -> Int64? {
            guard range.upperBound <= chars.count else { return nil }
            var value: Int64 = 0
            for index in range {
                let c = chars[index]
                guard c >= 48, c <= 57 else { return nil }
                value = value * 10 + Int64(c - 48)
            }
            return value
        }
        func char(_ index: Int, _ expected: Character) -> Bool {
            index < chars.count && chars[index] == expected.asciiValue
        }
        guard char(4, "-"), char(7, "-"), char(10, "T"), char(13, ":"), char(16, ":"),
            let year = number(0..<4), let month = number(5..<7), let day = number(8..<10),
            let hour = number(11..<13), let minute = number(14..<16), let second = number(17..<19),
            (1...12).contains(month), (1...31).contains(day), hour < 24, minute < 60, second < 60
        else { return nil }
        var millisecond: Int64 = 0
        var end = 19
        if char(19, ".") {
            guard let fraction = number(20..<23) else { return nil }
            millisecond = fraction
            end = 23
        }
        guard char(end, "Z"), end + 1 == chars.count else { return nil }
        let days = Instant.daysFromCivil(year: year, month: month, day: day)
        self.init(
            milliseconds: days * millisecondsPerDay + ((hour * 60 + minute) * 60 + second) * 1000
                + millisecond)
    }

    public var iso8601: String {
        let days = floorDiv(milliseconds, millisecondsPerDay)
        let inDay = milliseconds - days * millisecondsPerDay
        let (year, month, day) = Instant.civilFromDays(days)
        func pad(_ value: Int64, _ width: Int) -> String {
            let digits = String(value)
            return String(repeating: "0", count: max(0, width - digits.count)) + digits
        }
        return "\(pad(year, 4))-\(pad(month, 2))-\(pad(day, 2))T"
            + "\(pad(inDay / 3_600_000, 2)):\(pad(inDay / 60_000 % 60, 2)):\(pad(inDay / 1000 % 60, 2))"
            + ".\(pad(inDay % 1000, 3))Z"
    }

    /// 1970-01-01 からの日数（Howard Hinnant の days_from_civil）
    static func daysFromCivil(year: Int64, month: Int64, day: Int64) -> Int64 {
        let y = month <= 2 ? year - 1 : year
        let era = floorDiv(y, 400)
        let yearOfEra = y - era * 400
        let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    static func civilFromDays(_ days: Int64) -> (year: Int64, month: Int64, day: Int64) {
        let z = days + 719_468
        let era = floorDiv(z, 146_097)
        let dayOfEra = z - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146_096) / 365
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let mp = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        return (yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day)
    }
}

func floorDiv(_ a: Int64, _ b: Int64) -> Int64 {
    let q = a / b
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
}
