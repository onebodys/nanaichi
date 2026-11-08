import NanaichiDomain

/// 読み込んだ記録に当てる変更（記入を書いた・編集した・削除した、現在のセッションを重ねた、タグを削除した）
public typealias TimelineChange = @Sendable ([TimelineSession]) -> [TimelineSession]

/// 読み込み直した最新のページを、手元の記録に重ねる（Web の timeline-changes.ts）。
///
/// ページを読み込んでいる間に届いた変更（同期メッセージ）は、ページより新しいことがある。
/// 応答のほうが後に届くと、ページで置き換えたときにその変更が消えてしまう（書いた記入が一度出てから消える）。
/// そのため、ページで置き換えたあとに、読み込み始めてから届いた変更 `since` を順に当て直す。
/// どの変更も同じ記入・セッションで置き換えるだけなので、ページにすでに含まれていても二重にはならない
public func mergeLatestPage(_ sessions: [TimelineSession], page: [TimelineSession], since: [TimelineChange])
    -> [TimelineSession]
{
    since.reduce(Timeline.merge(sessions, page)) { merged, change in change(merged) }
}

/// 同期メッセージがタイムラインに当てる変更。タイムラインに関わらないものは nil
public func timelineChangeOf(_ message: SyncMessage) -> TimelineChange? {
    switch message {
    case .sessionChanged(.session(_, let session, _)):
        { Timeline.withCurrentSession($0, current: session) }
    case .journalEntrySaved(let entry): { Timeline.putEntry($0, entry) }
    case .journalEntryDeleted(let deleted): { Timeline.removeEntry($0, id: deleted.id) }
    case .tagDeleted(let deleted): { Timeline.deleteTag($0, deleted) }
    case .sessionChanged(.noSession), .advanceModeChanged, .taskSaved, .taskDeleted, .taskSettingChanged: nil
    }
}

/// スタッツと今日の集中時間を読み込み直すきっかけ（Web の stats-refresh.ts、ADR 0014）。この値が変わったときにだけ読み込み直す。
///
/// 完了セットが増えるのは集中を終えたときだけなので、今日の日付・現在のセッション・その完了セット数・
/// 終了したかを見ていれば、数が変わる時点をすべて捉えられる
public struct StatsRefreshKey: Hashable, Sendable {
    let today: LocalDate
    let session: SessionId?
    let ended: Bool
    let completedSets: Int?

    public static func of(_ timer: TimerView, serverNow: Instant, timeZone: TimeZoneName) -> StatsRefreshKey {
        let today = timeZone.localDate(at: serverNow)
        switch timer {
        case .loading, .loadFailed, .noSession:
            return StatsRefreshKey(today: today, session: nil, ended: false, completedSets: nil)
        case .inSession(let session, let state, _):
            return StatsRefreshKey(today: today, session: session.id, ended: false, completedSets: state.completedSets)
        case .ended(let session, let state):
            return StatsRefreshKey(today: today, session: session.id, ended: true, completedSets: state.completedSets)
        }
    }
}
