import NanaichiDomain
import Testing

@testable import NanaichiPresentation

private func entry(_ id: String, in session: Session, tags: [TagName] = [], at: Instant) -> JournalEntry {
    JournalEntry(
        id: JournalEntryId(id)!, sessionId: session.id, body: JournalEntryBody("書いた")!, tags: tags,
        writtenAt: at, updatedAt: at, writtenDuring: .focus(round: 1, setNumber: 1))
}

@Test("最新のページを読み込んでいる間に届いた記入の削除は、ページで置き換えたあとも残る")
func deletionWhileLoadingSurvivesPage() throws {
    let session = started()
    let written = entry("aaaaaaaa-0000-4000-8000-000000000001", in: session, at: minutes(1))
    let page = [TimelineSession(session: session, entries: [written])]
    let deleted = try #require(
        timelineChangeOf(.journalEntryDeleted(DeletedJournalEntry(id: written.id, deletedAt: minutes(2)))))
    let merged = mergeLatestPage([], page: page, since: [deleted])
    #expect(merged.map(\.entries) == [[]])
}

@Test("同期メッセージで届いた記入とタグの削除を、読み込んだ記録に当てる")
func syncMessagesChangeTimeline() throws {
    let session = started()
    let tagged = entry("aaaaaaaa-0000-4000-8000-000000000002", in: session, tags: [TagName("読書")!], at: minutes(1))
    let sessions = [TimelineSession(session: session, entries: [])]
    let save = try #require(timelineChangeOf(.journalEntrySaved(tagged)))
    let saved = save(sessions)
    #expect(saved.first?.entries == [tagged])
    let detach = try #require(timelineChangeOf(.tagDeleted(DeletedTag(name: TagName("読書")!, deletion: .detach))))
    #expect(detach(saved).first?.entries.first?.tags == [])
    let unrelated = timelineChangeOf(.advanceModeChanged(.allAuto))
    #expect(unrelated == nil)
}

@Test("始めたばかりのセッションは、セッションの変更が届くとタイムラインに区切りとして出る")
func sessionChangeAddsSession() throws {
    let session = started()
    let change = try #require(timelineChangeOf(.sessionChanged(session.snapshot(at: minutes(1)))))
    let sessions = change([])
    #expect(sessions.map(\.session.id) == [session.id])
    let noSession = timelineChangeOf(.sessionChanged(.noSession(serverTime: t0)))
    #expect(noSession == nil)
}

@Test("スタッツは完了セットが増えうるときと日付が変わったときだけ読み込み直す")
func statsRefreshKey() {
    let snapshot = received(started(), at: minutes(1))
    func key(at now: Instant) -> StatsRefreshKey {
        StatsRefreshKey.of(.of(.loaded(snapshot), deviceNow: now), serverNow: now, timeZone: tokyo)
    }
    #expect(key(at: minutes(1)) == key(at: minutes(5)))
    #expect(key(at: minutes(1)) != key(at: minutes(7, 30)))
    #expect(
        StatsRefreshKey.of(.noSession, serverNow: t0, timeZone: tokyo)
            != StatsRefreshKey.of(.noSession, serverNow: minutes(24 * 60), timeZone: tokyo))
}
