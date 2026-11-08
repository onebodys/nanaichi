/// スタッツ（GLOSSARY）の期間。週は月曜に始まる
public enum StatsPeriod: String, CaseIterable, Codable, Sendable {
    case today = "Today"
    case week = "Week"
    case month = "Month"
    case all = "All"
}

/// この12週間の集中に並べる週の数
private let calendarWeeks = 12

/// タグごとの完了セットに出すタグの数
private let topTags = 5

/// スタッツを数えるのに使う記入。本文は使わないので持たない
public struct EntryMark: Hashable, Sendable, Codable {
    public let sessionId: SessionId
    public let writtenAt: Instant
    public let writtenDuring: WrittenDuring
    public let tags: [TagName]

    public init(sessionId: SessionId, writtenAt: Instant, writtenDuring: WrittenDuring, tags: [TagName]) {
        self.sessionId = sessionId
        self.writtenAt = writtenAt
        self.writtenDuring = writtenDuring
        self.tags = tags
    }
}

/// スタッツを数えるもとの記録。すべてのセッションと、削除していない記入
public struct StatsRecords: Hashable, Sendable, Codable {
    public let sessions: [Session]
    public let entries: [EntryMark]

    public init(sessions: [Session], entries: [EntryMark]) {
        self.sessions = sessions
        self.entries = entries
    }
}

/// 1日の完了セット数。今日より後の日は、まだ来ていない日として分ける
public enum CalendarDay: Hashable, Sendable {
    case day(date: LocalDate, completedSets: Int)
    case upcoming(date: LocalDate)
}

public struct MonthCount: Hashable, Sendable {
    public let year: Int
    public let month: Int
    public let completedSets: Int
}

/// 日ごとの集中。今日は1日しかないので出さず、すべては月ごとにする
public enum StatsTrend: Hashable, Sendable {
    case none
    case days([CalendarDay])
    case months([MonthCount])
}

/// 前の期間の同じ時点までの完了セット数。すべての期間には前の期間がない
public enum StatsComparison: Hashable, Sendable {
    case compared(previousCompletedSets: Int)
    case notCompared
}

public struct TagCount: Hashable, Sendable {
    public let name: TagName
    public let completedSets: Int
}

/// 期間の中に記録があるときのスタッツ
public struct ActiveStats: Hashable, Sendable {
    public let completedSets: Int
    public let abortedSets: Int
    public let comparison: StatsComparison
    public let entries: Int
    /// 記入率（GLOSSARY）の分子。紐付く記入がある完了セットの数
    public let completedSetsWithEntry: Int
    public let trend: StatsTrend
    /// 多い順に5つまで
    public let tags: [TagCount]
    /// 0時台から23時台までの完了セット数（集中を終えた時刻で数える）
    public let hours: [Int]
}

/// 期間の中の記録。完了セットも不成立セットも記入もなければ `noActivity`
public enum StatsActivity: Hashable, Sendable {
    case noActivity
    case active(ActiveStats)
}

public struct StatsRange: Hashable, Sendable, Codable {
    public let from: LocalDate
    public let to: LocalDate
}

public struct Streak: Hashable, Sendable {
    public let current: Int
    public let longest: Int
}

/// スタッツ（GLOSSARY、`GET /api/stats` の応答、ADR 0014）。
///
/// - `range`: 期間の最初と最後の日付。すべてなら最初のセッションの日から今日まで
/// - `streak`・`calendar`: 期間に関わらず、今日までの記録から数える
public struct StatsReport: Hashable, Sendable, Codable {
    public let serverTime: Instant
    public let period: StatsPeriod
    public let today: LocalDate
    public let range: StatsRange
    public let activity: StatsActivity
    public let streak: Streak
    /// この12週間の日ごと。月曜始まりの週を古い順に並べ、週の中も月曜から
    public let calendar: [CalendarDay]

    /// 期間 `today` のスタッツから、今日の完了セット数。ヘッダーの今日の集中時間のもと
    public var completedSets: Int {
        switch activity {
        case .active(let active): active.completedSets
        case .noActivity: 0
        }
    }
}

// MARK: - 数えるもとにする出来事

/// 完了セット・不成立セット・記入を、端末のタイムゾーンでの日付と時刻に置いたもの
private struct Happening {
    let dayNumber: Int
    let minuteOfDay: Int

    var hour: Int { minuteOfDay / 60 }

    init(_ local: LocalTime) {
        dayNumber = local.date.dayNumber
        minuteOfDay = local.minuteOfDay
    }
}

private struct SetKey: Hashable {
    let sessionId: SessionId
    let round: Int
    let setNumber: Int
}

private struct CompletedSetAt {
    let happening: Happening
    let setKey: SetKey
}

private struct Happenings {
    let completed: [CompletedSetAt]
    let aborted: [Happening]
    let entries: [Happening]
    /// セットごとの、紐付く記入についたタグ（記入のないセットは入らない）
    let tagsBySet: [SetKey: Set<TagName>]
    let firstDayNumber: Int?
}

/// 記入が紐付くセット。休憩中の記入はどのセットにも紐付かない（GLOSSARY「ジャーナル記入」）
private func setKey(of entry: EntryMark) -> SetKey? {
    switch entry.writtenDuring {
    case .focus(let round, let setNumber), .journal(let round, let setNumber),
        .idle(let round, let setNumber):
        SetKey(sessionId: entry.sessionId, round: round, setNumber: setNumber)
    case .breakTime: nil
    }
}

private func happenings(of records: StatsRecords, now: Instant, timeZone: TimeZoneName) -> Happenings {
    func at(_ time: Instant) -> Happening { Happening(timeZone.localTime(at: time)) }

    var tagsBySet: [SetKey: Set<TagName>] = [:]
    for entry in records.entries {
        if let key = setKey(of: entry) { tagsBySet[key, default: []].formUnion(entry.tags) }
    }

    var completed: [CompletedSetAt] = []
    var aborted: [Happening] = []
    for session in records.sessions {
        for outcome in session.setOutcomesAt(now) {
            switch outcome {
            case .completedSet(let round, let setNumber, let time):
                completed.append(
                    CompletedSetAt(
                        happening: at(time),
                        setKey: SetKey(sessionId: session.id, round: round, setNumber: setNumber)))
            case .abortedSet(_, _, let time):
                aborted.append(at(time))
            }
        }
    }

    return Happenings(
        completed: completed, aborted: aborted,
        entries: records.entries.filter { $0.writtenAt <= now }.map { at($0.writtenAt) },
        tagsBySet: tagsBySet,
        firstDayNumber: records.sessions.map { at($0.events.start.event.at).dayNumber }.min())
}

// MARK: - 期間

/// 期間。日付は `dayNumber`（両端を含む）
private struct DayRange {
    let from: Int
    let to: Int

    func contains(_ happening: Happening) -> Bool { (from...to).contains(happening.dayNumber) }
}

/// 前の期間の同じ時点まで。`fullDays` 日目までは丸ごと、その次の日は `untilMinute` 分までを含む。
/// 前の期間がその日まで届かなければ（先月のほうが短いとき）、前の期間を丸ごと含む
private struct PreviousRange {
    let from: Int
    let to: Int
    let fullDays: Int
    let untilMinute: Int

    func containsUpToSamePoint(_ happening: Happening) -> Bool {
        guard (from...to).contains(happening.dayNumber) else { return false }
        let index = happening.dayNumber - from
        return index < fullDays || (index == fullDays && happening.minuteOfDay <= untilMinute)
    }
}

private func range(of period: StatsPeriod, today: LocalDate, firstDayNumber: Int?) -> DayRange {
    let todayNumber = today.dayNumber
    switch period {
    case .today:
        return DayRange(from: todayNumber, to: todayNumber)
    case .week:
        let monday = todayNumber - today.weekdayFromMonday
        return DayRange(from: monday, to: monday + 6)
    case .month:
        let first = LocalDate.firstOfMonth(year: today.year, month: today.month).dayNumber
        return DayRange(
            from: first, to: first + LocalDate.daysInMonth(year: today.year, month: today.month) - 1)
    case .all:
        return DayRange(from: min(firstDayNumber ?? todayNumber, todayNumber), to: todayNumber)
    }
}

private func previousRange(of period: StatsPeriod, today: LocalDate, range: DayRange, minuteOfDay: Int)
    -> PreviousRange?
{
    let offset = today.dayNumber - range.from
    switch period {
    case .today, .week:
        let length = range.to - range.from + 1
        return PreviousRange(
            from: range.from - length, to: range.from - 1, fullDays: offset, untilMinute: minuteOfDay)
    case .month:
        let (year, month) = today.month == 1 ? (today.year - 1, 12) : (today.year, today.month - 1)
        return PreviousRange(
            from: LocalDate.firstOfMonth(year: year, month: month).dayNumber, to: range.from - 1,
            fullDays: offset, untilMinute: minuteOfDay)
    case .all:
        return nil
    }
}

// MARK: - 数える

private func countByDay(_ happenings: [Happening]) -> [Int: Int] {
    happenings.reduce(into: [:]) { counts, happening in counts[happening.dayNumber, default: 0] += 1 }
}

private func calendarDays(_ range: DayRange, todayNumber: Int, counts: [Int: Int]) -> [CalendarDay] {
    (range.from...range.to).map { dayNumber in
        let date = LocalDate(dayNumber: dayNumber)
        return dayNumber > todayNumber
            ? .upcoming(date: date) : .day(date: date, completedSets: counts[dayNumber] ?? 0)
    }
}

private func months(_ range: DayRange, completed: [Happening]) -> [MonthCount] {
    let first = LocalDate(dayNumber: range.from)
    let last = LocalDate(dayNumber: range.to)
    func index(of date: LocalDate) -> Int { (date.year - first.year) * 12 + (date.month - first.month) }
    var counts = Array(repeating: 0, count: index(of: last) + 1)
    for happening in completed { counts[index(of: LocalDate(dayNumber: happening.dayNumber))] += 1 }
    return counts.enumerated().map { index, completedSets in
        let month0 = first.month - 1 + index
        return MonthCount(
            year: first.year + month0 / 12, month: month0 % 12 + 1, completedSets: completedSets)
    }
}

private func trend(of period: StatsPeriod, range: DayRange, todayNumber: Int, completed: [Happening])
    -> StatsTrend
{
    switch period {
    case .today: .none
    case .week, .month: .days(calendarDays(range, todayNumber: todayNumber, counts: countByDay(completed)))
    case .all: .months(months(range, completed: completed))
    }
}

private func tagCounts(_ completed: [CompletedSetAt], tagsBySet: [SetKey: Set<TagName>]) -> [TagCount] {
    var counts: [TagName: Int] = [:]
    for set in completed {
        for tag in tagsBySet[set.setKey] ?? [] { counts[tag, default: 0] += 1 }
    }
    let sorted = counts.map { TagCount(name: $0.key, completedSets: $0.value) }.sorted { a, b in
        a.completedSets != b.completedSets
            ? a.completedSets > b.completedSets
            : a.name.rawValue.jsLocaleCompare(b.name.rawValue) == .orderedAscending
    }
    return Array(sorted.prefix(topTags))
}

private func hours(_ completed: [Happening]) -> [Int] {
    var counts = Array(repeating: 0, count: 24)
    for happening in completed { counts[happening.hour] += 1 }
    return counts
}

/// 連続日数（GLOSSARY）。今日まだ完了セットがなければ昨日から数える。
/// 最長は、これまでの記録の中で完了セットのある日がいちばん長く続いた日数
private func streak(_ days: Set<Int>, todayNumber: Int) -> Streak {
    func countBack(from start: Int) -> Int {
        var count = 0
        while days.contains(start - count) { count += 1 }
        return count
    }
    return Streak(
        current: countBack(from: days.contains(todayNumber) ? todayNumber : todayNumber - 1),
        longest: days.filter { !days.contains($0 + 1) }.map { countBack(from: $0) }.max() ?? 0)
}

public enum Stats {
    /// 時刻 `now` までの記録から、期間 `period` のスタッツを数える（GLOSSARY「スタッツ」、ADR 0014）。
    ///
    /// - 日付と時間帯はタイムゾーン `timeZone`（端末のタイムゾーン）で区切る
    /// - 完了セットは集中を終えた時刻、不成立セットは中断・終了した時刻、記入は書いた時刻の日付に数える
    /// - 進行中のセッションは `now` までに完了したものを数える
    /// - 集中時間は、前の期間の同じ時点まで（何日目の何時何分まで）と比べる
    public static func of(records: StatsRecords, period: StatsPeriod, now: Instant, timeZone: TimeZoneName)
        -> StatsReport
    {
        let nowLocal = timeZone.localTime(at: now)
        let today = nowLocal.date
        let todayNumber = today.dayNumber
        let all = happenings(of: records, now: now, timeZone: timeZone)
        let range = range(of: period, today: today, firstDayNumber: all.firstDayNumber)

        let completed = all.completed.filter { range.contains($0.happening) }
        let aborted = all.aborted.filter(range.contains)
        let entries = all.entries.filter(range.contains)
        let previous = previousRange(
            of: period, today: today, range: range, minuteOfDay: nowLocal.minuteOfDay)

        let monday = todayNumber - today.weekdayFromMonday
        let calendarRange = DayRange(from: monday - (calendarWeeks - 1) * 7, to: monday + 6)
        let activity: StatsActivity =
            completed.count + aborted.count + entries.count == 0
            ? .noActivity
            : .active(
                ActiveStats(
                    completedSets: completed.count,
                    abortedSets: aborted.count,
                    comparison: previous.map { previous in
                        .compared(
                            previousCompletedSets: all.completed.count {
                                previous.containsUpToSamePoint($0.happening)
                            })
                    } ?? .notCompared,
                    entries: entries.count,
                    completedSetsWithEntry: completed.count { all.tagsBySet[$0.setKey] != nil },
                    trend: trend(
                        of: period, range: range, todayNumber: todayNumber,
                        completed: completed.map(\.happening)),
                    tags: tagCounts(completed, tagsBySet: all.tagsBySet),
                    hours: hours(completed.map(\.happening))))

        return StatsReport(
            serverTime: now, period: period, today: today,
            range: StatsRange(from: LocalDate(dayNumber: range.from), to: LocalDate(dayNumber: range.to)),
            activity: activity,
            streak: streak(Set(all.completed.map(\.happening.dayNumber)), todayNumber: todayNumber),
            calendar: calendarDays(
                calendarRange, todayNumber: todayNumber, counts: countByDay(all.completed.map(\.happening))))
    }
}

// MARK: - JSON（API の応答と同じ形。ADR 0009）

extension CalendarDay: Codable {
    private enum Kind: String, Codable {
        case day = "Day"
        case upcoming = "Upcoming"
    }

    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        let date = try fields.decode(LocalDate.self, forKey: "date")
        switch try decoder.kind(Kind.self) {
        case .day: self = .day(date: date, completedSets: try fields.decode("completedSets", atLeast: 0))
        case .upcoming: self = .upcoming(date: date)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .day(let date, let completedSets):
            try encoder.encode(kind: Kind.day) {
                try $0.encode(date, forKey: "date")
                try $0.encode(completedSets, forKey: "completedSets")
            }
        case .upcoming(let date):
            try encoder.encode(kind: Kind.upcoming) { try $0.encode(date, forKey: "date") }
        }
    }
}

extension MonthCount: Codable {
    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        year = try fields.decode(Int.self, forKey: "year")
        month = try fields.decode("month", atLeast: 1)
        completedSets = try fields.decode("completedSets", atLeast: 0)
        guard month <= 12 else {
            throw DecodingError.dataCorruptedError(
                forKey: "month", in: fields, debugDescription: "月ではない: \(month)")
        }
    }
}

extension StatsTrend: Codable {
    private enum Kind: String, Codable {
        case none = "None"
        case days = "Days"
        case months = "Months"
    }

    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        switch try decoder.kind(Kind.self) {
        case .none: self = .none
        case .days: self = .days(try fields.decode([CalendarDay].self, forKey: "days"))
        case .months: self = .months(try fields.decode([MonthCount].self, forKey: "months"))
        }
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

extension StatsComparison: Codable {
    private enum Kind: String, Codable {
        case compared = "Compared"
        case notCompared = "NotCompared"
    }

    public init(from decoder: any Decoder) throws {
        switch try decoder.kind(Kind.self) {
        case .compared:
            self = .compared(
                previousCompletedSets: try decoder.fields().decode("previousCompletedSets", atLeast: 0))
        case .notCompared: self = .notCompared
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .compared(let count):
            try encoder.encode(kind: Kind.compared) { try $0.encode(count, forKey: "previousCompletedSets") }
        case .notCompared: try encoder.encode(kind: Kind.notCompared) { _ in }
        }
    }
}

extension TagCount: Codable {
    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        name = try fields.decode(TagName.self, forKey: "name")
        completedSets = try fields.decode("completedSets", atLeast: 0)
    }
}

extension Streak: Codable {
    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        current = try fields.decode("current", atLeast: 0)
        longest = try fields.decode("longest", atLeast: 0)
    }
}

extension ActiveStats: Codable {
    public init(from decoder: any Decoder) throws {
        let fields = try decoder.fields()
        completedSets = try fields.decode("completedSets", atLeast: 0)
        abortedSets = try fields.decode("abortedSets", atLeast: 0)
        comparison = try fields.decode(StatsComparison.self, forKey: "comparison")
        entries = try fields.decode("entries", atLeast: 0)
        completedSetsWithEntry = try fields.decode("completedSetsWithEntry", atLeast: 0)
        trend = try fields.decode(StatsTrend.self, forKey: "trend")
        tags = try fields.decode([TagCount].self, forKey: "tags")
        hours = try fields.decode([Int].self, forKey: "hours")
        guard hours.count == 24, hours.allSatisfy({ $0 >= 0 }) else {
            throw DecodingError.dataCorruptedError(
                forKey: "hours", in: fields, debugDescription: "0 以上の 24 個の数ではない")
        }
    }
}

extension StatsActivity: Codable {
    private enum Kind: String, Codable {
        case noActivity = "NoActivity"
        case active = "Active"
    }

    public init(from decoder: any Decoder) throws {
        switch try decoder.kind(Kind.self) {
        case .noActivity: self = .noActivity
        case .active: self = .active(try ActiveStats(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .noActivity: try encoder.encode(kind: Kind.noActivity) { _ in }
        case .active(let active): try encoder.encode(kind: Kind.active, active)
        }
    }
}
