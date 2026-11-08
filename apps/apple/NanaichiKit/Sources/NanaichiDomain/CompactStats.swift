/// MCP の `get_stats` が返すスタッツ（Issue #89）。AI の文脈を無駄に使わないよう、`StatsReport` を小さくしたもの。
///
/// - 日付は `YYYY-MM-DD` の文字列にする
/// - まだ来ていない日と、完了セットのない時間帯は省く
/// - この12週間の日ごとは、求めたとき（`CompactStatsReportWithCalendar`）だけ入れる
public struct CompactStatsReport: Hashable, Sendable, Encodable {
    public let period: StatsPeriod
    public let today: String
    public let range: Range
    public let activity: Activity
    public let streak: Streak

    public struct Range: Hashable, Sendable, Encodable {
        public let from: String
        public let to: String
    }

    /// AI が読む1日の完了セット数。日付は `YYYY-MM-DD`
    public struct Day: Hashable, Sendable, Encodable {
        public let date: String
        public let completedSets: Int
    }

    /// AI が読む1か月の完了セット数。月は `YYYY-MM`
    public struct Month: Hashable, Sendable, Encodable {
        public let month: String
        public let completedSets: Int
    }

    public struct Hour: Hashable, Sendable, Encodable {
        public let hour: Int
        public let completedSets: Int
    }

    public enum Trend: Hashable, Sendable {
        case none
        case days([Day])
        case months([Month])
    }

    public struct Active: Hashable, Sendable, Encodable {
        public let completedSets: Int
        public let abortedSets: Int
        public let comparison: StatsComparison
        public let entries: Int
        public let completedSetsWithEntry: Int
        public let trend: Trend
        public let tags: [TagCount]
        /// 完了セットのある時間帯だけを、0時台から順に
        public let hours: [Hour]
    }

    public enum Activity: Hashable, Sendable {
        case noActivity
        case active(Active)
    }
}

/// この12週間の日ごと（今日まで、古い順）も入れたスタッツ。JSON では同じオブジェクトに `calendar` を足す
public struct CompactStatsReportWithCalendar: Hashable, Sendable, Encodable {
    public let report: CompactStatsReport
    public let calendar: [CompactStatsReport.Day]

    public func encode(to encoder: any Encoder) throws {
        try report.encode(to: encoder)
        var container = encoder.container(keyedBy: JSONKey.self)
        try container.encode(calendar, forKey: "calendar")
    }
}

private func pastDays(_ days: [CalendarDay]) -> [CompactStatsReport.Day] {
    days.compactMap { day in
        switch day {
        case .day(let date, let completedSets):
            CompactStatsReport.Day(date: date.key, completedSets: completedSets)
        case .upcoming: nil
        }
    }
}

private func compact(_ trend: StatsTrend) -> CompactStatsReport.Trend {
    switch trend {
    case .none: .none
    case .days(let days): .days(pastDays(days))
    case .months(let months):
        .months(
            months.map {
                CompactStatsReport.Month(
                    month: "\(pad($0.year, 4))-\(pad($0.month, 2))", completedSets: $0.completedSets)
            })
    }
}

private func compact(_ activity: StatsActivity) -> CompactStatsReport.Activity {
    switch activity {
    case .noActivity:
        return .noActivity
    case .active(let active):
        return .active(
            CompactStatsReport.Active(
                completedSets: active.completedSets, abortedSets: active.abortedSets,
                comparison: active.comparison, entries: active.entries,
                completedSetsWithEntry: active.completedSetsWithEntry, trend: compact(active.trend),
                tags: active.tags,
                hours: active.hours.enumerated().compactMap { hour, completedSets in
                    completedSets == 0
                        ? nil : CompactStatsReport.Hour(hour: hour, completedSets: completedSets)
                }))
    }
}

public enum CompactStats {
    /// スタッツを、AI が読む小さな形にする。この12週間の日ごとは入れない
    public static func of(_ report: StatsReport) -> CompactStatsReport {
        CompactStatsReport(
            period: report.period, today: report.today.key,
            range: CompactStatsReport.Range(from: report.range.from.key, to: report.range.to.key),
            activity: compact(report.activity), streak: report.streak)
    }

    /// スタッツを、AI が読む小さな形にする。この12週間の日ごと（今日まで）も入れる
    public static func withCalendarOf(_ report: StatsReport) -> CompactStatsReportWithCalendar {
        CompactStatsReportWithCalendar(report: of(report), calendar: pastDays(report.calendar))
    }
}

extension CompactStatsReport.Trend: Encodable {
    private enum Kind: String {
        case none = "None"
        case days = "Days"
        case months = "Months"
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .none: try encoder.encode(kind: Kind.none) { _ in }
        case .days(let days): try encoder.encode(kind: Kind.days) { try $0.encode(days, forKey: "days") }
        case .months(let months):
            try encoder.encode(kind: Kind.months) { try $0.encode(months, forKey: "months") }
        }
    }
}

extension CompactStatsReport.Activity: Encodable {
    private enum Kind: String {
        case noActivity = "NoActivity"
        case active = "Active"
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .noActivity: try encoder.encode(kind: Kind.noActivity) { _ in }
        case .active(let active): try encoder.encode(kind: Kind.active, active)
        }
    }
}
