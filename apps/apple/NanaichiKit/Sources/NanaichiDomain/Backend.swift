/// 記録先に届かなかった・断られた（TS の `BackendError`、ADR 0019）。HTTP のステータスは含めない
public enum BackendError: Error, Hashable, Sendable {
    /// いま記録に届かない（オフラインなど）。やり直せば通りうる
    case unreachable
    /// 想定内の失敗。`ApiErrorCode` で扱いを決める（どちらの記録先でも同じコード）
    case rejected(ApiErrorCode)
    /// この端末への保存に失敗した（端末に記録を置く場合だけ）
    case storageFailed(StorageFailure)
    /// 応答や保存した記録が、読めない形だった。アプリと記録の食い違いか障害
    case broken
}

public enum StorageFailure: Hashable, Sendable {
    /// 保存先がいっぱい
    case quotaExceeded
    /// 保存先を開けない・書けない
    case unavailable
    /// 新しい版のアプリが書いた記録。読み書きせずに残す
    case newerFormat
}

/// 同期メッセージ（ADR 0012）の受け取り口に届くもの
public enum SyncEvent: Hashable, Sendable {
    /// 繋がった（繋ぎ直した）。届かなかった変更があるかもしれないので、画面は読み込み直す
    case connected
    case message(SyncMessage)
}

/// 画面が使う記録先（ADR 0019「画面は記録先を知らない」）。この端末の記録先とアカウントの記録先の2つの実装がある
public protocol Backend: Sendable {
    func getCurrentSession() async -> Result<SessionSnapshot, BackendError>
    /// セッションを開始する。`id` は開始の操作イベントの ID（ADR 0007）。
    /// やり直すときは同じ ID で送れば、二重に開始しない
    func startSession(id: SessionEventId) async -> Result<SessionSnapshot, BackendError>
    func operateSession(id: SessionEventId, kind: SessionOperationKind) async
        -> Result<SessionSnapshot, BackendError>
    /// ジャーナル記入を書く。`id` は記入の ID（ADR 0010）。やり直すときは同じ ID で送れば、二重に書かない。
    /// `body` は入力したままの本文で、空白だけなら断られる
    func writeJournalEntry(id: JournalEntryId, body: String, tags: [TagName]) async
        -> Result<JournalEntry, BackendError>
    func editJournalEntry(id: JournalEntryId, body: String, tags: [TagName]) async
        -> Result<JournalEntry, BackendError>
    func deleteJournalEntry(id: JournalEntryId) async -> Result<DeletedJournalEntry, BackendError>
    /// タイムラインの1ページ。`before` が nil なら最新のページ
    func getTimeline(before: Instant?) async -> Result<TimelinePage, BackendError>
    /// 入力の候補に出す、使っているタグ（最近使った順）
    func getTags() async -> Result<TagList, BackendError>
    /// 設定画面に出す、使っているタグとその記入の数（最近使った順）
    func getTagUsage() async -> Result<TagUsageList, BackendError>
    /// タグを削除する。ついている記入からは外すか、`deletion` の付け替え先に付け替える（ADR 0017）
    func deleteTag(name: TagName, deletion: TagDeletion) async -> Result<DeletedTag, BackendError>
    /// 期間のスタッツ（ADR 0014）。日付と時間帯は端末のタイムゾーン `timeZone` で区切る
    func getStats(period: StatsPeriod, timeZone: TimeZoneName) async -> Result<StatsReport, BackendError>
    /// ジャーナルのカレンダーの1か月分。記入は `timeZone` で区切った日付に数える
    func getJournalCalendar(month: JournalMonth, timeZone: TimeZoneName) async
        -> Result<JournalCalendar, BackendError>
    /// `timeZone` で区切った日付 `date` に書いた記入
    func getEntriesOnDate(date: LocalDate, timeZone: TimeZoneName) async
        -> Result<EntriesOnDate, BackendError>
    /// タグのついた記入の1ページ（新しい順）。`before` が nil なら最新のページ
    func getEntriesWithTag(tag: TagName, before: Instant?) async -> Result<TaggedEntriesPage, BackendError>
    func getAdvanceMode() async -> Result<AdvanceMode, BackendError>
    /// フェーズの進め方を変える。変えたあとの進め方が返る
    func changeAdvanceMode(_ mode: AdvanceMode) async -> Result<AdvanceMode, BackendError>
    /// 同期メッセージを受け取り始める。受け取り始めると、まず `connected` が届く。
    /// 受け取るのをやめるには、ストリームを読むタスクを止める
    func subscribe() async -> AsyncStream<SyncEvent>
    /// 今すぐ繋がっているかを確かめる。画面に戻ってきたときやオンラインに戻ったときに呼ぶ
    func checkSyncConnection() async
}
