import NanaichiDomain
import NanaichiPresentation
import SwiftUI

/// スタッツのウィンドウで見るもの。タグは使っているものをサイドバーに並べ、選ぶとそのタグのついた記入を見返す
enum ReviewDestination: Hashable {
    case stats
    case calendar
    case tag(TagName)
}

/// スタッツとジャーナル記入の見返し（GLOSSARY の「スタッツ」、Web の stats-screen.tsx・journal-lookup.tsx）。
///
/// Web はホームに重ねて出すが、Mac ではタイマーの隣に並べて見られる別のウィンドウにし、サイドバーで
/// スタッツ・ジャーナルのカレンダー・タグごとの記入を切り替える（Mail のメールボックスと同じ形）
struct ReviewWindow: View {
    let app: AppServices
    @State private var destination: ReviewDestination?

    init(app: AppServices, destination: ReviewDestination = .stats) {
        self.app = app
        _destination = State(initialValue: destination)
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $destination) {
                Section("振り返り") {
                    Label("スタッツ", systemImage: "chart.bar.xaxis")
                        .tag(ReviewDestination.stats)
                        .accessibilityIdentifier("review.stats")
                    Label("ジャーナルのカレンダー", systemImage: "calendar")
                        .tag(ReviewDestination.calendar)
                        .accessibilityIdentifier("review.calendar")
                }
                Section("タグ") {
                    if app.tags.known.isEmpty {
                        Text("タグのついた記入はまだありません")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(app.tags.known, id: \.self) { name in
                        Label(tagTextOf(name), systemImage: "number")
                            .tag(ReviewDestination.tag(name))
                            .accessibilityIdentifier("review.tag.\(name.rawValue)")
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 210)
        } detail: {
            switch destination ?? .stats {
            case .stats: StatsView(app: app)
            case .calendar:
                JournalCalendarView(review: app.review, today: deviceTimeZone().localDate(at: app.timer.serverNow))
            case .tag(let name): TaggedEntriesView(review: app.review, tag: name)
            }
        }
        .onChange(of: app.tags.known) { _, known in
            // 削除したタグを見ていたら、スタッツに戻る
            if case .tag(let name) = destination, !known.contains(name) { destination = .stats }
        }
    }
}

// MARK: - ジャーナルのカレンダー

/// ジャーナルのカレンダー（GLOSSARY）。月曜始まりの週に並べ、記入のある日に数を出す。選んだ日の記入を右に並べる
struct JournalCalendarView: View {
    let review: ReviewModel
    /// 今日（端末のタイムゾーン）。開いたときは今日を選ぶ
    let today: LocalDate
    @State private var month: JournalMonth?
    @State private var selected: LocalDate?

    private var thisMonth: JournalMonth { JournalMonth(year: today.year, month: today.month)! }
    private var shownMonth: JournalMonth { month ?? thisMonth }
    private var selectedDate: LocalDate { selected ?? today }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(spacing: 12) {
                monthHeader
                calendarGrid
                Spacer()
            }
            .padding(20)
            .frame(width: 320)
            Divider()
            EntriesOnDateView(review: review, date: selectedDate)
        }
        .navigationTitle("ジャーナルのカレンダー")
        .task(id: LoadKey(shownMonth, review.revision)) { await review.loadCalendar(shownMonth) }
    }

    private var monthHeader: some View {
        HStack {
            Button {
                month = shownMonth.before
            } label: {
                Image(systemName: "chevron.left")
            }
            .help("前の月")
            .accessibilityLabel("前の月")
            .accessibilityIdentifier("calendar.previous")
            Spacer()
            Text(monthTextOf(shownMonth))
                .font(.headline)
                .accessibilityIdentifier("calendar.month")
            Spacer()
            Button {
                month = shownMonth.after
            } label: {
                Image(systemName: "chevron.right")
            }
            .disabled(shownMonth == thisMonth)
            .help("次の月")
            .accessibilityLabel("次の月")
            .accessibilityIdentifier("calendar.next")
        }
        .buttonStyle(.borderless)
    }

    private var calendarGrid: some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)
        return VStack(spacing: 6) {
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(weekdayHeaders, id: \.self) { weekday in
                    Text(weekday).font(.caption).foregroundStyle(.secondary)
                }
            }
            LoadableContent(
                loadable: review.calendar.view(for: shownMonth), what: "カレンダー",
                reload: { Task { await review.loadCalendar(shownMonth) } }
            ) { calendar in
                LazyVGrid(columns: columns, spacing: 4) {
                    let leading = LocalDate.firstOfMonth(year: shownMonth.year, month: shownMonth.month)
                        .weekdayFromMonday
                    ForEach(0..<leading, id: \.self) { _ in Color.clear.frame(height: 36) }
                    ForEach(calendar.days, id: \.self) { day in
                        CalendarDayCell(day: day, today: calendar.today, selected: selectedDate) { selected = $0 }
                    }
                }
            }
        }
    }
}

private struct CalendarDayCell: View {
    let day: JournalCalendarDay
    let today: LocalDate
    let selected: LocalDate
    let select: (LocalDate) -> Void

    var body: some View {
        switch day {
        case .upcoming(let date):
            Text("\(date.day)")
                .font(.callout)
                .foregroundStyle(.quaternary)
                .frame(maxWidth: .infinity, minHeight: 36)
                .accessibilityHidden(true)
        case .day(let date, let entries):
            let isSelected = date == selected
            Button {
                select(date)
            } label: {
                VStack(spacing: 1) {
                    Text("\(date.day)")
                        .font(.callout.weight(date == today ? .bold : .regular))
                    Text(entries > 0 ? "\(entries)" : " ")
                        .font(.system(size: 9))
                        .foregroundStyle(isSelected ? AnyShapeStyle(.white.opacity(0.85)) : AnyShapeStyle(.secondary))
                }
                .foregroundStyle(isSelected ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
                .frame(maxWidth: .infinity, minHeight: 36)
                .background(
                    isSelected
                        ? AnyShapeStyle(Color.accentColor)
                        : entries > 0 ? AnyShapeStyle(PhaseStyle.focus.color.opacity(0.14)) : AnyShapeStyle(.clear),
                    in: RoundedRectangle(cornerRadius: 7))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(calendarDayLabelOf(date, entries: entries))
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityIdentifier("calendar.day.\(date.key)")
        }
    }
}

/// 選んだ日の記入。書いた順
private struct EntriesOnDateView: View {
    let review: ReviewModel
    let date: LocalDate

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text(dateTextOf(date))
                        .font(.title3.bold())
                        .accessibilityIdentifier("entriesOnDate.title")
                    Spacer()
                    if let loaded = review.entriesOnDate.view(for: date).value {
                        Text(entryCountLabelOf(loaded.entries.count))
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("entriesOnDate.count")
                    }
                }
                .padding(.bottom, 8)
                Divider()
                LoadableContent(
                    loadable: review.entriesOnDate.view(for: date), what: "記入",
                    reload: { Task { await review.loadEntries(on: date) } }
                ) { loaded in
                    if loaded.entries.isEmpty {
                        Text("この日の記入はありません")
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 20)
                    }
                    ForEach(loaded.entries, id: \.id) { entry in
                        ReadOnlyEntry(entry: entry)
                        Divider()
                    }
                }
            }
            .padding(20)
        }
        .task(id: LoadKey(date, review.revision)) { await review.loadEntries(on: date) }
    }
}

// MARK: - タグのついた記入

/// タグのついた記入。新しい順に、書いた日付で区切る
struct TaggedEntriesView: View {
    let review: ReviewModel
    let tag: TagName

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                LoadableContent(
                    loadable: review.view(taggedWith: tag), what: "記入",
                    reload: { Task { await review.loadTagged(tag) } }
                ) { list in
                    if list.entries.isEmpty {
                        Text("このタグのついた記入はありません").foregroundStyle(.secondary)
                    }
                    ForEach(TaggedEntries.byDate(list.entries, timeZone: deviceTimeZone()), id: \.date) { day in
                        Text(dateTextOf(day.date))
                            .font(.headline)
                            .padding(.top, 16)
                            .padding(.bottom, 4)
                        Divider()
                        ForEach(day.entries, id: \.id) { entry in
                            ReadOnlyEntry(entry: entry)
                            Divider()
                        }
                    }
                    if list.next != .end {
                        Button(review.loadingMore ? "読み込み中…" : "さらに読み込む") {
                            Task { await review.loadMoreTagged() }
                        }
                        .disabled(review.loadingMore)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 16)
                    }
                }
            }
            .padding(20)
        }
        .navigationTitle(tagTextOf(tag))
        .accessibilityIdentifier("taggedEntries")
        .task(id: LoadKey(tag, review.revision)) { await review.loadTagged(tag) }
    }
}

/// 読み込み直すきっかけ。見るものか、記入やタグが変わった回数が変わったら読み込み直す
struct LoadKey<Key: Hashable>: Hashable {
    let key: Key
    let revision: Int

    init(_ key: Key, _ revision: Int) {
        self.key = key
        self.revision = revision
    }
}
