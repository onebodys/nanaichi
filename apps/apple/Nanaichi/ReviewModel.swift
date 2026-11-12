import Foundation
import NanaichiDomain
import NanaichiPresentation
import Observation

/// `key` ごとに読み込んだもの（Web の use-journal-lookup.ts の `useLoad`）。
///
/// 画面は `.task(id:)` で読み込むので、続けて切り替えたときは前の読み込みが取り消され、古い応答で新しい表示を
/// 上書きしない。読み込み直している間は、同じ `key` で前に読み込んだものを出し続ける
@Observable
@MainActor
final class Loader<Key: Hashable, Value> {
    private var loaded: (key: Key, value: Value)?
    private var failed: Key?

    func view(for key: Key) -> Loadable<Value> {
        if let loaded, loaded.key == key { return .loaded(loaded.value) }
        return failed == key ? .loadFailed : .loading
    }

    func load(_ key: Key, _ fetch: () async -> Result<Value, BackendError>) async {
        let result = await fetch()
        guard !Task.isCancelled else { return }
        switch result {
        case .success(let value):
            loaded = (key, value)
            failed = nil
        case .failure:
            failed = key
        }
    }
}

/// タグのついた記入。読み込んだページを重ねたもの
struct TaggedEntriesList {
    let tag: TagName
    let entries: [JournalEntry]
    let next: PageCursor
}

/// スタッツとジャーナル記入の見返し（GLOSSARY の「スタッツ」「ジャーナルのカレンダー」、Web の use-stats.ts・
/// use-journal-lookup.ts）。数えるのは記録先で（ADR 0014）、ここは読み込んで持つだけ。
///
/// 記入やタグが変わったという同期メッセージが届くたびに `revision` を進め、開いている画面が読み込み直す。
/// スタッツはタイマーの完了セットが増えうるときにも読み込み直す（`StatsRefreshKey`）
@Observable
@MainActor
final class ReviewModel {
    var period: StatsPeriod = .today
    /// 記入やタグが変わった回数。画面が読み込み直すきっかけ
    private(set) var revision = 0
    let stats = Loader<StatsPeriod, StatsReport>()
    let calendar = Loader<JournalMonth, JournalCalendar>()
    let entriesOnDate = Loader<LocalDate, EntriesOnDate>()
    private(set) var tagged: Loadable<TaggedEntriesList> = .loading
    private(set) var loadingMore = false

    @ObservationIgnored let backend: any Backend

    init(backend: any Backend) {
        self.backend = backend
    }

    func run() async {
        for await event in await backend.subscribe() {
            switch event {
            case .message(.journalEntrySaved), .message(.journalEntryDeleted), .message(.tagDeleted):
                revision += 1
            case .connected, .message(.sessionChanged), .message(.advanceModeChanged), .message(.taskSaved),
                .message(.taskDeleted), .message(.taskSettingChanged):
                break
            }
        }
    }

    func loadStats(_ period: StatsPeriod) async {
        await stats.load(period) { await backend.getStats(period: period, timeZone: deviceTimeZone()) }
    }

    func loadCalendar(_ month: JournalMonth) async {
        await calendar.load(month) { await backend.getJournalCalendar(month: month, timeZone: deviceTimeZone()) }
    }

    func loadEntries(on date: LocalDate) async {
        await entriesOnDate.load(date) { await backend.getEntriesOnDate(date: date, timeZone: deviceTimeZone()) }
    }

    /// タグ `tag` のついた記入の最新のページを読む。別のタグに切り替えたら、前のタグのページは捨てる
    func loadTagged(_ tag: TagName) async {
        if case .loaded(let list) = tagged, list.tag != tag { tagged = .loading }
        let result = await backend.getEntriesWithTag(tag: tag, before: nil)
        guard !Task.isCancelled else { return }
        tagged = tagged.replacing(with: result.map { TaggedEntriesList(tag: tag, entries: $0.entries, next: $0.next) })
    }

    func view(taggedWith tag: TagName) -> Loadable<TaggedEntriesList> {
        if case .loaded(let list) = tagged, list.tag != tag { return .loading }
        return tagged
    }

    /// 続きのページを足す。読めなければボタンを残してもう一度押せるようにする
    func loadMoreTagged() async {
        guard !loadingMore, case .loaded(let list) = tagged, case .more(let before) = list.next else { return }
        loadingMore = true
        defer { loadingMore = false }
        guard case .success(let page) = await backend.getEntriesWithTag(tag: list.tag, before: before),
            case .loaded(let current) = tagged, current.tag == list.tag
        else { return }
        tagged = .loaded(
            TaggedEntriesList(
                tag: list.tag, entries: TaggedEntries.merge(current.entries, page.entries), next: page.next))
    }
}
