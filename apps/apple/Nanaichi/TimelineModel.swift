import Foundation
import NanaichiDomain
import NanaichiPresentation
import Observation

/// 画面に出すタイムラインの様子
enum TimelineDays {
    case loading
    case loadFailed
    case loaded(days: [TimelineDay], hasMore: Bool)
}

/// タイムラインの状態と、記入の編集・削除（Web の use-timeline.ts）。
///
/// - 最新のページを読み込み、「さらに読み込む」で古いページを足す（ADR 0011）
/// - 書いた・編集した・削除した記入、削除したタグ、セッションの変更は同期メッセージで受け取って重ねる（ADR 0012）。
///   この端末の記録先は、自分の変更も同期メッセージで送る
/// - 日付の区切りと完了セット数は、記録先の今の時刻の見積もりと端末のタイムゾーンでドメインが組み立てる
@Observable
@MainActor
final class TimelineModel {
    private enum Loading {
        case loading
        case loadFailed
        case loaded(sessions: [TimelineSession], next: PageCursor)
    }

    private var loading: Loading = .loading
    private(set) var loadingMore = false
    /// 直前の編集・削除・読み込みの失敗
    private(set) var errorMessage: String?

    @ObservationIgnored private let backend: any Backend
    /// 最新のページを読み込んでいる間に当てた変更。応答が届いたら、ページの上に当て直す（`mergeLatestPage`）
    @ObservationIgnored private var changesWhileLoading: [(seq: Int, change: TimelineChange)] = []
    @ObservationIgnored private var lastSeq = 0
    @ObservationIgnored private var loadsInFlight = 0

    init(backend: any Backend) {
        self.backend = backend
    }

    /// 同期メッセージを受け取り続ける。アプリが動いている間ずっと呼んだままにする
    func run() async {
        for await event in await backend.subscribe() {
            switch event {
            case .connected: await loadLatest()
            case .message(let message):
                if let change = timelineChangeOf(message) { apply(change) }
            }
        }
    }

    /// 時刻 `now`（記録先の時刻の見積もり）のタイムライン
    func days(now: Instant) -> TimelineDays {
        switch loading {
        case .loading: .loading
        case .loadFailed: .loadFailed
        case .loaded(let sessions, let next):
            .loaded(
                days: Timeline.build(sessions: sessions, next: next, now: now, timeZone: deviceTimeZone()),
                hasMore: next != .end)
        }
    }

    /// 記入やセッションの変更を当てる。最新のページを読み込んでいる間なら、当て直すために覚えておく
    private func apply(_ change: @escaping TimelineChange) {
        if loadsInFlight > 0 {
            lastSeq += 1
            changesWhileLoading.append((lastSeq, change))
        }
        if case .loaded(let sessions, let next) = loading {
            loading = .loaded(sessions: change(sessions), next: next)
        }
    }

    private func loadLatest() async {
        let since = lastSeq
        loadsInFlight += 1
        let result = await backend.getTimeline(before: nil)
        loadsInFlight -= 1
        let changes = changesWhileLoading.filter { $0.seq > since }.map(\.change)
        if loadsInFlight == 0 { changesWhileLoading = [] }
        switch (result, loading) {
        case (.success(let page), .loaded(let sessions, let next)):
            // 古いページを読み込み済みなら、その続きの位置はそのまま使う
            loading = .loaded(sessions: mergeLatestPage(sessions, page: page.sessions, since: changes), next: next)
        case (.success(let page), .loading), (.success(let page), .loadFailed):
            loading = .loaded(sessions: mergeLatestPage([], page: page.sessions, since: changes), next: page.next)
        case (.failure, .loading), (.failure, .loadFailed):
            loading = .loadFailed
        case (.failure, .loaded):
            break
        }
    }

    func reload() {
        loading = .loading
        Task { await loadLatest() }
    }

    func loadMore() async {
        guard !loadingMore, case .loaded(_, .more(let before)) = loading else { return }
        loadingMore = true
        defer { loadingMore = false }
        switch await backend.getTimeline(before: before) {
        case .success(let page):
            if case .loaded(let sessions, _) = loading {
                loading = .loaded(sessions: Timeline.merge(sessions, page.sessions), next: page.next)
            }
        case .failure(let error):
            errorMessage = entryChangeErrorMessageOf(error)
        }
    }

    /// 記入の本文とタグを書き直す。書き直せたら true（編集を閉じる）
    func edit(_ id: JournalEntryId, body: String, tags: [TagName]) async -> Bool {
        errorMessage = nil
        switch await backend.editJournalEntry(id: id, body: body, tags: tags) {
        case .success(let entry):
            apply { Timeline.putEntry($0, entry) }
            return true
        case .failure(let error):
            errorMessage = entryChangeErrorMessageOf(error)
            return false
        }
    }

    func remove(_ id: JournalEntryId) async {
        errorMessage = nil
        switch await backend.deleteJournalEntry(id: id) {
        case .success: apply { Timeline.removeEntry($0, id: id) }
        case .failure(let error): errorMessage = entryChangeErrorMessageOf(error)
        }
    }
}
