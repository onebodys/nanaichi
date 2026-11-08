/// ジャーナル記入を読む期間（GLOSSARY「MCP サーバー」）。`from` と `to` の日付を両端とも含み、
/// 日付はタイムゾーン `timeZone` で区切る（スタッツと同じ考え方、ADR 0014）
public struct JournalPeriod: Hashable, Sendable, Codable {
    public let from: LocalDate
    public let to: LocalDate
    public let timeZone: TimeZoneName

    /// 1回に読める期間の日数の上限。1年分の振り返りまでは1回で読め、誤って何年分も読んで
    /// 応答が大きくなりすぎるのを防ぐ
    public static let maxDays = 366

    /// `from` が `to` より後の日付か、期間が長すぎれば作れない（TS の `JournalPeriodQuerySchema`）
    public init?(from: LocalDate, to: LocalDate, timeZone: TimeZoneName) {
        guard from <= to, to.dayNumber - from.dayNumber < JournalPeriod.maxDays else { return nil }
        self.from = from
        self.to = to
        self.timeZone = timeZone
    }

    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        guard
            let period = JournalPeriod(
                from: try fields.decode(LocalDate.self, forKey: "from"),
                to: try fields.decode(LocalDate.self, forKey: "to"),
                timeZone: try fields.decode(TimeZoneName.self, forKey: "timeZone"))
        else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "from が to より後か、期間が長すぎる"))
        }
        self = period
    }

    /// 期間の時刻の範囲。`from` の日の 0:00 から、`to` の翌日の 0:00 の手前まで
    public var range: WrittenWindow {
        WrittenWindow(from: timeZone.startOfDay(from), until: timeZone.startOfDay(to.adding(days: 1)))
    }

    /// 期間に書いた記入（書いた順）に、書いた日付と時刻を添える
    public func report(_ entries: [JournalEntry]) -> JournalPeriodReport {
        JournalPeriodReport(
            period: self,
            entries: entries.map { entry in
                let local = timeZone.localTime(at: entry.writtenAt)
                return JournalPeriodEntry(
                    entry: entry, writtenOn: local.date.key,
                    writtenAtLocalTime: "\(pad(local.minuteOfDay / 60, 2)):\(pad(local.minuteOfDay % 60, 2))")
            })
    }
}

/// 期間に書いた記入を、書いた日付と時刻（期間のタイムゾーン）とともに並べたもの。
/// JSON では記入と同じオブジェクトに `writtenOn` と `writtenAtLocalTime` を足す
public struct JournalPeriodEntry: Hashable, Sendable, Codable {
    public let entry: JournalEntry
    /// 書いた日付（`YYYY-MM-DD`）
    public let writtenOn: String
    /// 書いた時刻（`HH:MM`）。AI が読んで日ごと・時間帯ごとにまとめやすいよう、時刻もタイムゾーンで出す
    public let writtenAtLocalTime: String

    init(entry: JournalEntry, writtenOn: String, writtenAtLocalTime: String) {
        self.entry = entry
        self.writtenOn = writtenOn
        self.writtenAtLocalTime = writtenAtLocalTime
    }

    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        entry = try JournalEntry(from: decoder)
        writtenOn = try fields.decode(String.self, forKey: "writtenOn")
        writtenAtLocalTime = try fields.decode(String.self, forKey: "writtenAtLocalTime")
    }

    public func encode(to encoder: any Encoder) throws {
        try entry.encode(to: encoder)
        var container = encoder.container(keyedBy: JSONKey.self)
        try container.encode(writtenOn, forKey: "writtenOn")
        try container.encode(writtenAtLocalTime, forKey: "writtenAtLocalTime")
    }
}

public struct JournalPeriodReport: Hashable, Sendable, Codable {
    public let period: JournalPeriod
    /// 書いた順（古い順）
    public let entries: [JournalPeriodEntry]

    /// MCP のツールが返す JSON の形。期間の日付を `YYYY-MM-DD` の文字列にする（TS の `JournalPeriod.toJson`）
    public var json: JournalPeriodReportJson {
        JournalPeriodReportJson(
            period: .init(from: period.from.key, to: period.to.key, timeZone: period.timeZone.identifier),
            entries: entries)
    }
}

public struct JournalPeriodReportJson: Hashable, Sendable, Encodable {
    public let period: Period
    public let entries: [JournalPeriodEntry]

    public struct Period: Hashable, Sendable, Encodable {
        public let from: String
        public let to: String
        public let timeZone: String
    }
}
