import Foundation
import NanaichiDomain

// スタッツ（GLOSSARY）の文言。判断はせず、ドメインの値を言葉にするだけ（Web の stats-text.ts）

public func periodTextOf(_ period: StatsPeriod) -> String {
    switch period {
    case .today: "今日"
    case .week: "週"
    case .month: "月"
    case .all: "すべて"
    }
}

/// 期間の見出し（`10月12日（月） 〜 10月18日（日）`、月なら `2026年10月`）
public func rangeTextOf(_ report: StatsReport) -> String {
    let from = report.range.from
    switch report.period {
    case .today: return dateTextOf(from)
    case .week: return "\(dateTextOf(from)) 〜 \(dateTextOf(report.range.to))"
    case .month: return "\(from.year)年\(from.month)月"
    case .all: return "\(from.year)年\(dateTextOf(from)) 〜 今日"
    }
}

/// 完了セット数の集中時間（`7時間49分`）
public func focusTimeOfSetsTextOf(_ completedSets: Int) -> String {
    focusTimeTextOf(milliseconds: FocusTime.ofCompletedSets(completedSets))
}

private func previousTextOf(_ period: StatsPeriod) -> String {
    switch period {
    case .today: "昨日の同じ時刻"
    case .week: "先週の同じ時点"
    case .month, .all: "先月の同じ時点"
    }
}

/// 前の期間の同じ時点までとの集中時間の差（`先週の同じ時点より +52分`）。比べられなければ出さない
public func comparisonTextOf(_ period: StatsPeriod, _ active: ActiveStats) -> String? {
    guard case .compared(let previousCompletedSets) = active.comparison else { return nil }
    let diff = active.completedSets - previousCompletedSets
    let previous = previousTextOf(period)
    if diff == 0 { return "\(previous)と同じ" }
    return "\(previous)より \(diff > 0 ? "+" : "−")\(focusTimeOfSetsTextOf(abs(diff)))"
}

/// 割合（`88%`）。もとになる数がなければ `—`。JS の `Math.round` と同じく 0.5 は切り上げる
private func percentTextOf(_ part: Int, _ whole: Int) -> String {
    whole == 0 ? "—" : "\(Int((Double(part) / Double(whole) * 100 + 0.5).rounded(.down)))%"
}

/// 完了率（GLOSSARY）
public func completionRateTextOf(_ active: ActiveStats) -> String {
    percentTextOf(active.completedSets, active.completedSets + active.abortedSets)
}

/// 記入率（GLOSSARY）
public func entryRateTextOf(_ active: ActiveStats) -> String {
    percentTextOf(active.completedSetsWithEntry, active.completedSets)
}

/// この12週間の集中の、1日の濃さ（0〜4）。1ラウンド（3セット）ごとに1段濃くし、3ラウンドで最も濃くする
public func heatLevelOf(_ completedSets: Int) -> Int {
    switch completedSets {
    case 0: 0
    case 1..<3: 1
    case 3..<6: 2
    case 6..<9: 3
    default: 4
    }
}

/// いちばん完了セットの多い時間帯（0〜23）。同じなら早い時間。完了セットがなければ nil
public func peakHourOf(_ hours: [Int]) -> Int? {
    guard let max = hours.max(), max > 0 else { return nil }
    return hours.firstIndex(of: max)
}

/// いちばん完了セットの多い時間帯（`14時台`）
public func peakHourTextOf(_ hours: [Int]) -> String? {
    peakHourOf(hours).map { "\($0)時台" }
}

/// 期間の中に記録がないときの見出し
public func noActivityTitleOf(_ period: StatsPeriod) -> String {
    switch period {
    case .today: "今日の記録はまだありません"
    case .week: "今週の記録はまだありません"
    case .month: "今月の記録はまだありません"
    case .all: "まだ記録がありません"
    }
}

/// 日ごとの集中の棒の下に出す目盛り。週は曜日、月は詰まるので1日と7日おきだけ
public func trendDayAxisTextOf(_ date: LocalDate, dense: Bool) -> String {
    guard dense else { return weekdayTextOf(date) }
    return date.day == 1 || date.day % 7 == 1 ? "\(date.day)" : ""
}

/// 月ごとの集中に出す月。長くなりすぎないよう、直近の12か月まで
public func recentMonthsOf(_ months: [MonthCount]) -> [MonthCount] { Array(months.suffix(12)) }

/// 月ごとの集中の目盛り（`10月`）
public func monthCountTextOf(_ month: MonthCount) -> String { "\(month.month)月" }

/// 続けている日数の補足。最長がなければ出さない
public func longestStreakTextOf(_ streak: Streak) -> String? {
    streak.longest > 0 ? "最長 \(streak.longest)日" : nil
}

/// 集中した時間の補足（`12セット · 先週の同じ時点より +52分`）
public func focusTimeNoteOf(_ period: StatsPeriod, _ active: ActiveStats) -> String {
    (["\(active.completedSets)セット"] + [comparisonTextOf(period, active)].compactMap { $0 }).joined(separator: " · ")
}
