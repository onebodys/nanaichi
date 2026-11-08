import Charts
import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// スタッツ（GLOSSARY、Web の stats-screen.tsx）。期間はツールバーのセグメントで切り替える。
/// 数えるのは記録先で（ADR 0014）、ここは受け取った値を描くだけ。タイマーの完了セットが増えうるときと、
/// 記入やタグが変わったときに読み込み直す
struct StatsView: View {
    let app: AppServices
    private var review: ReviewModel { app.review }

    var body: some View {
        @Bindable var review = review
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let report = review.stats.view(for: review.period).value {
                    Text(rangeTextOf(report))
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("stats.range")
                }
                LoadableContent(
                    loadable: review.stats.view(for: review.period), what: "スタッツ",
                    reload: { Task { await review.loadStats(review.period) } }
                ) { report in
                    ReportView(report: report)
                }
            }
            .padding(24)
            .frame(maxWidth: 1080, alignment: .leading)
        }
        .navigationTitle("スタッツ")
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("期間", selection: $review.period) {
                    ForEach(StatsPeriod.allCases, id: \.self) { period in
                        Text(periodTextOf(period)).tag(period)
                    }
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .accessibilityIdentifier("stats.period")
            }
        }
        .task(id: StatsLoadKey(period: review.period, refresh: app.timer.statsRefreshKey, revision: review.revision)) {
            await review.loadStats(review.period)
        }
    }
}

private struct StatsLoadKey: Hashable {
    let period: StatsPeriod
    let refresh: StatsRefreshKey
    let revision: Int
}

private struct ReportView: View {
    let report: StatsReport

    var body: some View {
        switch report.activity {
        case .noActivity:
            HStack(alignment: .top, spacing: 12) {
                StreakKpi(streak: report.streak)
                    .frame(maxWidth: 240)
                Spacer()
            }
            Card(title: noActivityTitleOf(report.period)) {
                Text("集中を最後まで終えると、集中した時間やジャーナル記入がここに積み上がります。")
                    .foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("stats.noActivity")
            CalendarCard(calendar: report.calendar)
        case .active(let active):
            ActiveReport(report: report, active: active)
        }
    }
}

private struct ActiveReport: View {
    let report: StatsReport
    let active: ActiveStats

    var body: some View {
        Grid(horizontalSpacing: 12, verticalSpacing: 12) {
            GridRow {
                Kpi(
                    label: "集中した時間", value: focusTimeOfSetsTextOf(active.completedSets),
                    note: focusTimeNoteOf(report.period, active), identifier: "focusTime")
                Kpi(
                    label: "セットの完了率", value: completionRateTextOf(active),
                    note: "不成立 \(active.abortedSets)セット", identifier: "completionRate")
                Kpi(
                    label: "ジャーナル記入", value: "\(active.entries)", note: "記入率 \(entryRateTextOf(active))",
                    identifier: "entries")
                StreakKpi(streak: report.streak)
            }
        }
        TrendCard(trend: active.trend, today: report.today)
        HStack(alignment: .top, spacing: 12) {
            TagsCard(tags: active.tags)
            HoursCard(hours: active.hours)
        }
        CalendarCard(calendar: report.calendar)
    }
}

// MARK: - 部品

private struct Card<Content: View>: View {
    let title: String
    var note: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline)
                Spacer()
                if let note { Text(note).font(.caption).foregroundStyle(.secondary) }
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct Kpi: View {
    let label: String
    let value: String
    let note: String?
    let identifier: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.callout).foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 28, weight: .medium, design: .rounded))
                .monospacedDigit()
                .accessibilityIdentifier("stats.\(identifier)")
            Text(note ?? " ").font(.caption).foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
    }
}

private struct StreakKpi: View {
    let streak: Streak

    var body: some View {
        Kpi(label: "続けている日数", value: "\(streak.current)日", note: longestStreakTextOf(streak), identifier: "streak")
    }
}

/// 日ごと・月ごとの集中。今日は1日しかないので出さない
private struct TrendCard: View {
    let trend: StatsTrend
    let today: LocalDate

    var body: some View {
        switch trend {
        case .none:
            EmptyView()
        case .days(let days):
            Card(title: "日ごとの集中", note: "完了セット × 7分") {
                DaysChart(days: days, today: today)
            }
        case .months(let months):
            Card(title: "月ごとの集中", note: "完了セット × 7分") {
                MonthsChart(months: recentMonthsOf(months))
            }
        }
    }
}

private struct DaysChart: View {
    let days: [CalendarDay]
    let today: LocalDate

    private struct Bar: Identifiable {
        let id: String
        let axis: String
        let completedSets: Int
        let isToday: Bool
        let upcoming: Bool
    }

    private var bars: [Bar] {
        let dense = days.count > 7
        return days.map { day in
            switch day {
            case .day(let date, let completedSets):
                Bar(
                    id: date.key, axis: trendDayAxisTextOf(date, dense: dense), completedSets: completedSets,
                    isToday: date == today, upcoming: false)
            case .upcoming(let date):
                Bar(
                    id: date.key, axis: trendDayAxisTextOf(date, dense: dense), completedSets: 0, isToday: false,
                    upcoming: true)
            }
        }
    }

    var body: some View {
        let bars = bars
        Chart(bars) { bar in
            BarMark(x: .value("日", bar.id), y: .value("集中", bar.completedSets * 7))
                .foregroundStyle(PhaseStyle.focus.color.opacity(bar.isToday ? 1 : 0.4))
                .annotation(position: .top) {
                    if bars.count <= 7, bar.completedSets > 0 {
                        Text(focusTimeOfSetsTextOf(bar.completedSets))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
        }
        .chartXAxis {
            AxisMarks(values: bars.map(\.id)) { value in
                AxisValueLabel {
                    if let id = value.as(String.self), let bar = bars.first(where: { $0.id == id }) {
                        Text(bar.axis).fontWeight(bar.isToday ? .bold : .regular)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks { value in
                AxisGridLine()
                AxisValueLabel { if let minutes = value.as(Int.self) { Text("\(minutes)分") } }
            }
        }
        .frame(height: 180)
        .accessibilityLabel(
            days.compactMap { day -> String? in
                guard case .day(let date, let completedSets) = day else { return nil }
                return "\(dateTextOf(date)) \(focusTimeOfSetsTextOf(completedSets))"
            }.joined(separator: "、"))
        .accessibilityIdentifier("stats.trend")
    }
}

private struct MonthsChart: View {
    let months: [MonthCount]

    var body: some View {
        Chart(Array(months.enumerated()), id: \.offset) { index, month in
            BarMark(x: .value("月", "\(month.year)-\(month.month)"), y: .value("集中", month.completedSets * 7))
                .foregroundStyle(PhaseStyle.focus.color.opacity(index == months.count - 1 ? 1 : 0.4))
        }
        .chartXAxis {
            AxisMarks(values: months.map { "\($0.year)-\($0.month)" }) { value in
                AxisValueLabel {
                    if let key = value.as(String.self), let month = months.first(where: { "\($0.year)-\($0.month)" == key }) {
                        Text(monthCountTextOf(month))
                    }
                }
            }
        }
        .frame(height: 180)
        .accessibilityIdentifier("stats.trend")
    }
}

private struct TagsCard: View {
    let tags: [TagCount]

    var body: some View {
        Card(title: "よく使ったタグ") {
            if tags.isEmpty {
                Text("この期間に、タグのついた記入はありません。入力欄の上でタグをつけると、ここに出ます。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                Chart(tags, id: \.name) { tag in
                    BarMark(x: .value("完了セット", tag.completedSets), y: .value("タグ", tagTextOf(tag.name)))
                        .foregroundStyle(PhaseStyle.focus.color)
                        .annotation(position: .trailing) {
                            Text("\(tag.completedSets)セット").font(.caption).foregroundStyle(.secondary)
                        }
                }
                .chartXAxis(.hidden)
                .frame(height: CGFloat(tags.count) * 30 + 10)
                .accessibilityIdentifier("stats.tags")
            }
            Text("タグのついた記入があった完了セットを数えます")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct HoursCard: View {
    let hours: [Int]

    var body: some View {
        let peak = peakHourOf(hours)
        Card(title: "集中した時間帯") {
            Chart(Array(hours.enumerated()), id: \.offset) { hour, count in
                BarMark(x: .value("時", hour), y: .value("完了セット", count))
                    .foregroundStyle(PhaseStyle.focus.color.opacity(hour == peak ? 1 : 0.35))
            }
            .chartXScale(domain: -0.5...23.5)
            .chartXAxis {
                AxisMarks(values: [0, 6, 12, 18, 23]) { value in
                    AxisValueLabel { if let hour = value.as(Int.self) { Text("\(hour)時") } }
                }
            }
            .chartYAxis(.hidden)
            .frame(height: 110)
            .accessibilityIdentifier("stats.hours")
            if let text = peakHourTextOf(hours) {
                Text("いちばん集中できているのは **\(text)**")
                    .font(.callout)
                    .accessibilityIdentifier("stats.peakHour")
            }
        }
    }
}

/// この12週間。1マスが1日で、列が月曜始まりの週
private struct CalendarCard: View {
    let calendar: [CalendarDay]

    var body: some View {
        Card(title: "この12週間", note: "1マス = 1日") {
            let weeks = stride(from: 0, to: calendar.count, by: 7).map { Array(calendar[$0..<min($0 + 7, calendar.count)]) }
            HStack(alignment: .top, spacing: 4) {
                ForEach(weeks.indices, id: \.self) { index in
                    VStack(spacing: 4) {
                        ForEach(weeks[index], id: \.self) { day in cell(day) }
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                "この12週間で完了セットのあった日は\(calendar.count { if case .day(_, let sets) = $0 { sets > 0 } else { false } })日")
            .accessibilityIdentifier("stats.calendar")
            HStack(spacing: 4) {
                Text("少ない")
                ForEach(0..<5) { level in
                    RoundedRectangle(cornerRadius: 3).fill(heatColor(level)).frame(width: 12, height: 12)
                }
                Text("多い")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func cell(_ day: CalendarDay) -> some View {
        let shape = RoundedRectangle(cornerRadius: 3)
        switch day {
        case .day(let date, let completedSets):
            shape.fill(heatColor(heatLevelOf(completedSets)))
                .frame(width: 18, height: 18)
                .help("\(dateTextOf(date)) \(focusTimeOfSetsTextOf(completedSets))")
        case .upcoming:
            shape.strokeBorder(.separator, style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
                .frame(width: 18, height: 18)
        }
    }

    private func heatColor(_ level: Int) -> Color {
        level == 0 ? Color.secondary.opacity(0.15) : PhaseStyle.focus.color.opacity([0, 0.25, 0.5, 0.75, 1][level])
    }
}
