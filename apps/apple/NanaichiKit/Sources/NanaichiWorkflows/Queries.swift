import NanaichiDomain

// 読むだけのワークフロー。想定内の失敗はないので `Result` にしない

/// 入力の候補に出す、使っているタグの一覧（GLOSSARY の「タグ」、ADR 0013）
public func getTags(_ store: some TagStore) throws -> TagList {
    TagList(tags: try store.listTagsInUse())
}

/// 設定画面のタグの一覧に出す、使っているタグとその記入の数（GLOSSARY の「タグの削除」）
public func getTagUsage(_ store: some TagStore) throws -> TagUsageList {
    TagUsageList(tags: try store.listTagUsage())
}

public typealias GetTimelineStore = SessionStore & TimelineStore

/// タイムラインの1ページ（GLOSSARY の「タイムライン」、ADR 0011）。
///
/// 自動終了の時刻を過ぎたセッションを閉じる → 新しい順にセッションと記入を読む → ページにする。
/// 次のページがあるかを見分けるため、1件多く読む（`Timeline.page`）
public func getTimeline(_ store: some GetTimelineStore, before: Instant?, now: Instant) throws -> TimelinePage {
    _ = try loadOpenSession(store, now: now)
    let limit = Timeline.pageSize + 1
    let range: TimelineRange = before.map { .before($0, limit: limit) } ?? .latest(limit: limit)
    return Timeline.page(found: try store.findTimelineSessions(range), limit: Timeline.pageSize, serverTime: now)
}

/// タグ（GLOSSARY）のついた記入の1ページ。そのタグのついた記入を新しい順に読む → ページにする
public func getEntriesWithTag(_ store: some TaggedEntriesStore, tag: TagName, before: Instant?) throws
    -> TaggedEntriesPage
{
    let limit = TaggedEntries.pageSize + 1
    let range: TaggedEntriesRange =
        before.map { .before(tag: tag, $0, limit: limit) } ?? .latest(tag: tag, limit: limit)
    return TaggedEntries.page(
        tag: tag, found: try store.findJournalEntriesWithTag(range), limit: TaggedEntries.pageSize)
}

/// ジャーナルのカレンダー（GLOSSARY）の1か月分。その月の記入を書いた時刻を読む → 端末のタイムゾーンの日付ごとに数える
public func getJournalCalendar(
    _ store: some JournalCalendarStore, month: JournalMonth, timeZone: TimeZoneName, now: Instant
) throws -> JournalCalendar {
    JournalCalendar.of(
        month: month, writtenAts: try store.findEntryTimesWrittenIn(JournalCalendar.window(of: month)),
        now: now, timeZone: timeZone)
}

/// ジャーナルのカレンダーで選んだ日の記入。その日の前後の記入を読む → 端末のタイムゾーンでその日に書いたものに絞る
public func getEntriesOnDate(_ store: some JournalCalendarStore, date: LocalDate, timeZone: TimeZoneName) throws
    -> EntriesOnDate
{
    JournalCalendar.entriesOn(
        date, entries: try store.findJournalEntriesWrittenIn(JournalCalendar.window(of: date)), timeZone: timeZone)
}

public typealias GetStatsStore = SessionStore & StatsStore

/// スタッツ（GLOSSARY の「スタッツ」、ADR 0014）。
/// 自動終了の時刻を過ぎたセッションを閉じる → すべての記録を読む → 期間とタイムゾーンで数える
public func getStats(_ store: some GetStatsStore, period: StatsPeriod, timeZone: TimeZoneName, now: Instant) throws
    -> StatsReport
{
    _ = try loadOpenSession(store, now: now)
    return Stats.of(records: try store.findStatsRecords(), period: period, now: now, timeZone: timeZone)
}

/// いまのフェーズの進め方（ADR 0016）。変えたことがなければ既定（すべて自動）
public func getAdvanceMode(_ store: some AdvanceModeStore, now: Instant) throws -> AdvanceMode {
    AdvanceModeChange.modeAt(try store.loadAdvanceModeChanges(), now)
}
