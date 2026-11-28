import Foundation
import NanaichiDomain

#if DEBUG && os(macOS)
    import AppKit
#elseif DEBUG
    import UIKit
#endif

/// 画面が使う記録先。デバッグのビルドでは、XCUITest のためにジャーナル記入を送れなかったことにできる（`DebugFailingJournalWrites`）
func debugBackend(_ backend: any Backend) -> any Backend {
    #if DEBUG
        return DebugFailingJournalWrites.wrapping(backend, ProcessInfo.processInfo.environment)
    #else
        return backend
    #endif
}

#if DEBUG
    /// XCUITest が「送っている間に書き足して、送れなかった」場面を作るための記録先（Issue #80）。デバッグのビルドにだけある。
    ///
    /// 環境変数 `NANAICHI_FAIL_JOURNAL_WRITES` が `n` なら、はじめの n 回のジャーナル記入の書き込みを、
    /// テストが入力欄に書き足すまで待ってから通信できなかったことにする。それより後と、ほかの読み書きは `base` に渡す
    actor DebugFailingJournalWrites: Backend {
        private let base: any Backend
        private var failuresLeft: Int

        /// 書き足さずに送れなかった場面で、送れなかったことにするまで待つ長さ
        private static let delay = Duration.seconds(20)

        #if os(macOS)
            private static let edited = NSText.didChangeNotification
        #else
            private static let edited = UITextView.textDidChangeNotification
        #endif

        /// 環境変数がなければ `base` をそのまま返す
        static func wrapping(_ base: any Backend, _ environment: [String: String]) -> any Backend {
            guard let count = environment["NANAICHI_FAIL_JOURNAL_WRITES"].flatMap(Int.init), count > 0 else { return base }
            return DebugFailingJournalWrites(base: base, failures: count)
        }

        private init(base: any Backend, failures: Int) {
            self.base = base
            failuresLeft = failures
        }

        func writeJournalEntry(id: JournalEntryId, body: String, tags: [TagName]) async
            -> Result<JournalEntry, BackendError>
        {
            guard failuresLeft > 0 else { return await base.writeJournalEntry(id: id, body: body, tags: tags) }
            failuresLeft -= 1
            await Self.untilEdited()
            return .failure(.unreachable)
        }

        /// 入力欄に書き足されるまで（書き足されなければ `delay` だけ）待つ。決まった秒数だけ待つと、送信してから
        /// 書き足し始めるまでが遅いマシンでは、書き足す前に送れなかったことになる（CI で 4.6 秒かかったことがある、#93）。
        /// 書き足した文字は入力欄の利用者の編集として届き、送信で入力欄を空にしたことは届かない
        private static func untilEdited() async {
            let (signals, signal) = AsyncStream<Void>.makeStream()
            let observer = NotificationCenter.default.addObserver(forName: edited, object: nil, queue: nil) { _ in
                signal.yield()
            }
            let timeout = Task {
                try? await Task.sleep(for: delay)
                signal.yield()
            }
            for await _ in signals { break }
            timeout.cancel()
            NotificationCenter.default.removeObserver(observer)
        }

        func getCurrentSession() async -> Result<SessionSnapshot, BackendError> { await base.getCurrentSession() }
        func startSession(id: SessionEventId) async -> Result<SessionSnapshot, BackendError> {
            await base.startSession(id: id)
        }
        func operateSession(id: SessionEventId, kind: SessionOperationKind) async
            -> Result<SessionSnapshot, BackendError>
        { await base.operateSession(id: id, kind: kind) }
        func editJournalEntry(id: JournalEntryId, body: String, tags: [TagName]) async
            -> Result<JournalEntry, BackendError>
        { await base.editJournalEntry(id: id, body: body, tags: tags) }
        func deleteJournalEntry(id: JournalEntryId) async -> Result<DeletedJournalEntry, BackendError> {
            await base.deleteJournalEntry(id: id)
        }
        func getTimeline(before: Instant?) async -> Result<TimelinePage, BackendError> {
            await base.getTimeline(before: before)
        }
        // Mac のアプリにも画面の `TagList` があるので、記録先の型をモジュールの名前で指す
        func getTags() async -> Result<NanaichiDomain.TagList, BackendError> { await base.getTags() }
        func getTagUsage() async -> Result<TagUsageList, BackendError> { await base.getTagUsage() }
        func deleteTag(name: TagName, deletion: TagDeletion) async -> Result<DeletedTag, BackendError> {
            await base.deleteTag(name: name, deletion: deletion)
        }
        func getStats(period: StatsPeriod, timeZone: TimeZoneName) async -> Result<StatsReport, BackendError> {
            await base.getStats(period: period, timeZone: timeZone)
        }
        func getJournalCalendar(month: JournalMonth, timeZone: TimeZoneName) async
            -> Result<JournalCalendar, BackendError>
        { await base.getJournalCalendar(month: month, timeZone: timeZone) }
        func getEntriesOnDate(date: LocalDate, timeZone: TimeZoneName) async -> Result<EntriesOnDate, BackendError> {
            await base.getEntriesOnDate(date: date, timeZone: timeZone)
        }
        func getEntriesWithTag(tag: TagName, before: Instant?) async -> Result<TaggedEntriesPage, BackendError> {
            await base.getEntriesWithTag(tag: tag, before: before)
        }
        func getAdvanceMode() async -> Result<AdvanceMode, BackendError> { await base.getAdvanceMode() }
        func changeAdvanceMode(_ mode: AdvanceMode) async -> Result<AdvanceMode, BackendError> {
            await base.changeAdvanceMode(mode)
        }
        func subscribe() async -> AsyncStream<SyncEvent> { await base.subscribe() }
        func checkSyncConnection() async { await base.checkSyncConnection() }
        func clockOffset() async -> ClockOffset { await base.clockOffset() }
    }
#endif
