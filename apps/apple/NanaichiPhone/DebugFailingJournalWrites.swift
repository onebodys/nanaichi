#if DEBUG
    import NanaichiDomain

    /// XCUITest が「送っている間に書き足して、送れなかった」場面を作るための記録先（Issue #80）。デバッグのビルドにだけある。
    ///
    /// 環境変数 `NANAICHI_FAIL_JOURNAL_WRITES` が `n` なら、はじめの n 回のジャーナル記入の書き込みを、
    /// 少し待ってから通信できなかったことにする（その間にテストが入力欄に書き足す）。それより後と、ほかの読み書きは `base` に渡す
    actor DebugFailingJournalWrites: Backend {
        private let base: any Backend
        private var failuresLeft: Int

        /// 送れなかったことにするまで待つ長さ。テストが送信してから書き足し始めるまでより長くする
        private static let delay = Duration.seconds(3)

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
            try? await Task.sleep(for: Self.delay)
            return .failure(.unreachable)
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
        func getTags() async -> Result<TagList, BackendError> { await base.getTags() }
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
