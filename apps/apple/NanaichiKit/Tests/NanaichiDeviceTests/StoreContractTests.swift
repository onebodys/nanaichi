import Testing

@testable import NanaichiDevice
@testable import NanaichiDomain
@testable import NanaichiWorkflows

// Web の `apps/web/src/testing/store-contract.ts` と同じ場面の一覧を、この端末の SQLite の記録先に通す（ADR 0019・0028）。
// 期待する値は UserDO の SQLite の振る舞いを仕様として書いたもの

/// UserDO と同じ呼び方でワークフローを動かす。どの呼び出しのあとにも自動終了を確定させる
private struct Operator {
    let records: SQLiteRecords

    private func run<T>(_ now: Instant, _ work: () throws -> T) throws -> T {
        let result = try work()
        _ = try loadOpenSession(records, now: now)
        return result
    }

    func start(_ now: Instant, id: SessionEventId = eventId()) throws -> Result<SessionSnapshot, StartSessionError> {
        try run(now) { try startSession(records, id: id, now: now, newSessionId: sessionId()) }
    }

    func operate(_ now: Instant, _ kind: SessionOperationKind, id: SessionEventId = eventId()) throws
        -> Result<SessionSnapshot, OperateSessionError>
    {
        try run(now) { try operateSession(records, id: id, kind: kind, now: now) }
    }

    func current(_ now: Instant) throws -> SessionSnapshot {
        try run(now) { try getCurrentSession(records, now: now) }
    }

    func write(_ now: Instant, _ body: String, _ names: [String] = [], id: JournalEntryId = entryId()) throws
        -> Result<JournalEntry, WriteJournalEntryError>
    {
        try run(now) { try writeJournalEntry(records, id: id, body: body, tags: tags(names), now: now) }
    }

    func edit(_ now: Instant, _ id: JournalEntryId, _ body: String, _ names: [String]) throws
        -> Result<JournalEntry, EditJournalEntryError>
    {
        try run(now) { try editJournalEntry(records, id: id, body: body, tags: tags(names), now: now) }
    }

    func remove(_ now: Instant, _ id: JournalEntryId) throws -> Result<DeletedJournalEntry, DeleteJournalEntryError> {
        try run(now) { try deleteJournalEntry(records, id: id, now: now) }
    }

    func deleteTag(_ now: Instant, _ name: String, _ deletion: TagDeletion) throws
        -> Result<DeletedTag, DeleteTagRejected>
    {
        try run(now) { try NanaichiWorkflows.deleteTag(records, name: tag(name), deletion: deletion) }
    }

    func timeline(_ now: Instant, before: Instant? = nil) throws -> TimelinePage {
        try run(now) { try getTimeline(records, before: before, now: now) }
    }

    func tagList(_ now: Instant) throws -> [TagName] { try run(now) { try getTags(records).tags } }

    func tagUsage(_ now: Instant) throws -> [TagUsage] { try run(now) { try getTagUsage(records).tags } }

    func entriesWithTag(_ now: Instant, _ name: String, before: Instant? = nil) throws -> TaggedEntriesPage {
        try run(now) { try getEntriesWithTag(records, tag: tag(name), before: before) }
    }

    func calendar(_ now: Instant, _ month: JournalMonth) throws -> JournalCalendar {
        try run(now) { try getJournalCalendar(records, month: month, timeZone: tokyo, now: now) }
    }

    func entriesOnDate(_ now: Instant, _ date: String) throws -> EntriesOnDate {
        try run(now) { try getEntriesOnDate(records, date: LocalDate(key: date)!, timeZone: tokyo) }
    }

    func stats(_ now: Instant) throws -> StatsReport {
        try run(now) { try getStats(records, period: .all, timeZone: tokyo, now: now) }
    }

    func changeAdvanceMode(_ now: Instant, _ changed: AdvanceMode) throws -> AdvanceModeChangeResult {
        try run(now) { try NanaichiWorkflows.changeAdvanceMode(records, to: changed, now: now) }
    }

    func advanceMode(_ now: Instant) throws -> AdvanceMode { try run(now) { try getAdvanceMode(records, now: now) } }
}

private func ids(_ entries: [JournalEntry]) -> [JournalEntryId] { entries.map(\.id) }

private func ended(_ state: TimerState) -> TimerState.Ended? {
    guard case .ended(let ended) = state else { return nil }
    return ended
}

@Suite("セッションと操作イベント")
struct SessionContractTests {
    @Test("同じミリ秒の操作は記録した順に操作イベントに並ぶ")
    func sameMillisecond() throws {
        try freshStore { records in
            let store = Operator(records: records)
            _ = try store.start(at(0)).get()
            _ = try store.operate(at(5), .pause).get()
            _ = try store.operate(at(5), .resume).get()

            let (session, state) = try inSession(store.current(at(6)))

            #expect(session.events.operations.map(\.event.kind) == [.pause, .resume])
            #expect(state.kind == .focus)
        }
    }

    @Test("セッションは同時に1つしか開けず、同じ開始を送り直すと同じセッションが返る")
    func oneOpenSession() throws {
        try freshStore { records in
            let store = Operator(records: records)
            let startId = eventId()
            let first = try inSession(store.start(at(0), id: startId).get())

            #expect(try failed(store.start(at(1))) == .sessionAlreadyInProgress(first.session.id))
            let resent = try inSession(store.start(at(2), id: startId).get())
            #expect(resent.session.id == first.session.id)
            #expect(resent.session.events.operations.isEmpty)
        }
    }

    @Test("終了したセッションは閉じ直されず、次のセッションを開始できる")
    func closedSessionStaysClosed() throws {
        try freshStore { records in
            let store = Operator(records: records)
            let startId = eventId()
            let first = try inSession(store.start(at(0), id: startId).get())
            _ = try store.changeAdvanceMode(at(1), mode(.manual, .auto))
            _ = try store.operate(at(2), .end).get()
            _ = try store.changeAdvanceMode(at(3), mode(.manual, .manual))
            let next = try inSession(store.start(at(4)).get())

            try records.closeSession(
                first.session.id, TimerState.Ended(endedAt: at(10), endedBy: .autoEnd, completedSets: 0))

            #expect(try inSession(store.current(at(11))).session.id == next.session.id)
            let replayed = try inSession(store.start(at(12), id: startId).get())
            #expect(ended(replayed.state)?.endedBy == .end)
            #expect(ended(replayed.state)?.endedAt == at(2))
            #expect(replayed.session.advanceModeChanges == [AdvanceModeChange(at: at(1), mode: mode(.manual, .auto))])
        }
    }

    @Test("削除した記入も自動終了の時刻を延ばす")
    func deletedEntryExtendsAutoEnd() throws {
        try freshStore { records in
            let store = Operator(records: records)
            let startId = eventId()
            _ = try store.start(at(0), id: startId).get()
            let entry = try store.write(at(30), "書いて消す").get()
            _ = try store.remove(at(31), entry.id).get()

            #expect(try store.current(at(87)) != .noSession(serverTime: at(87)))
            #expect(try store.current(at(89)) == .noSession(serverTime: at(89)))
            let replayed = try inSession(store.start(at(90), id: startId).get())
            #expect(ended(replayed.state)?.endedBy == .autoEnd)
            #expect(ended(replayed.state)?.endedAt == at(30))
            #expect(replayed.session.journalEntryTimes == [at(30)])
        }
    }

    @Test("自動終了の時刻を過ぎると、記入しようとしたときに閉じてセッションの外になる")
    func autoEndOnWrite() throws {
        try freshStore { records in
            let store = Operator(records: records)
            _ = try store.start(at(0)).get()

            #expect(try failed(store.write(at(60), "遅すぎた")) == .noSessionInProgress)
            #expect(try records.findOpenSession() == nil)
        }
    }
}

@Suite("フェーズの進め方")
struct AdvanceModeContractTests {
    @Test("同じミリ秒に2回変えると、あとに変えたほうが効く")
    func lastChangeWins() throws {
        try freshStore { records in
            let store = Operator(records: records)
            _ = try store.changeAdvanceMode(at(0), mode(.manual, .auto))
            _ = try store.changeAdvanceMode(at(0), mode(.auto, .manual))

            #expect(try store.advanceMode(at(1)) == mode(.auto, .manual))
        }
    }

    @Test("セッションには始めた時刻に効いていた変更から含め、閉じたあとの変更は含めない")
    func relevantChanges() throws {
        try freshStore { records in
            let store = Operator(records: records)
            let startId = eventId()
            let before = AdvanceModeChange(at: at(-10), mode: mode(.manual, .auto))
            let effective = AdvanceModeChange(at: at(-5), mode: mode(.auto, .manual))
            let during = AdvanceModeChange(at: at(1), mode: mode(.manual, .manual))
            let after = AdvanceModeChange(at: at(3), mode: mode(.auto, .auto))
            _ = try store.changeAdvanceMode(before.at, before.mode)
            _ = try store.changeAdvanceMode(effective.at, effective.mode)
            _ = try store.start(at(0), id: startId).get()
            _ = try store.changeAdvanceMode(during.at, during.mode)

            #expect(try inSession(store.current(at(1, 30))).session.advanceModeChanges == [effective, during])

            _ = try store.operate(at(2), .end).get()
            _ = try store.changeAdvanceMode(after.at, after.mode)

            let replayed = try inSession(store.start(at(4), id: startId).get())
            #expect(replayed.session.advanceModeChanges == [effective, during])
            // スタッツは閉じた時刻で絞らない（閉じたあとの変更は計算に影響しない）
            #expect(try records.findStatsRecords().sessions.map(\.advanceModeChanges) == [[effective, during, after]])
            #expect(try store.advanceMode(at(5)) == after.mode)
        }
    }
}

@Suite("ジャーナル記入")
struct JournalEntryContractTests {
    @Test("同じ記入を送り直すと最初の記入が返り、削除した記入と同じ ID では書けない")
    func resendAndDeleted() throws {
        try freshStore { records in
            let store = Operator(records: records)
            _ = try store.start(at(0)).get()
            let id = entryId()
            _ = try store.write(at(1), "最初", id: id).get()

            let resent = try store.write(at(2), "送り直し", id: id).get()
            #expect(resent.body.unwrap() == "最初")
            #expect(resent.writtenAt == at(1))

            #expect(try store.remove(at(3), id).get() == DeletedJournalEntry(id: id, deletedAt: at(3)))
            #expect(try store.remove(at(4), id).get() == DeletedJournalEntry(id: id, deletedAt: at(3)))
            #expect(try failed(store.write(at(5), "もう一度", id: id)) == .journalEntryNotFound(JournalEntryNotFound(id: id)))
            #expect(try failed(store.edit(at(6), id, "直す", [])) == .journalEntryNotFound(JournalEntryNotFound(id: id)))
        }
    }

    @Test("終了したセッションの記入も編集でき、書いた時刻と紐付きは変わらない")
    func editAfterEnd() throws {
        try freshStore { records in
            let store = Operator(records: records)
            _ = try store.start(at(0)).get()
            let written = try store.write(at(1), "書いた", ["a"]).get()
            _ = try store.operate(at(2), .end).get()
            _ = try store.start(at(5)).get()
            let inProgress = try store.write(at(6), "進行中").get()

            let edited = try store.edit(at(10), written.id, "直した", ["b"]).get()

            #expect(edited.writtenAt == at(1))
            #expect(edited.updatedAt == at(10))
            #expect(edited.writtenDuring == written.writtenDuring)
            let sessions = try store.timeline(at(11)).sessions
            #expect(sessions.count == 2)
            #expect(ids(sessions[0].entries) == [inProgress.id])
            #expect(sessions[1].entries.map { $0.body.unwrap() } == ["直した"])
            #expect(sessions[1].entries.map(\.tags) == [[tag("b")]])
            #expect(sessions[1].entries.first?.updatedAt == at(10))
        }
    }

    @Test("カレンダーと選んだ日の記入は、範囲の始まりを含み終わりを含まず、削除した記入を除く")
    func calendarWindow() throws {
        try freshStore { records in
            let store = Operator(records: records)
            _ = try store.start(at(0)).get()
            let first = try store.write(at(1), "1").get()
            let second = try store.write(at(2), "2").get()
            let removed = try store.write(at(2, 30), "消す").get()
            let third = try store.write(at(3), "3").get()
            _ = try store.remove(at(4), removed.id).get()
            let window = WrittenWindow(from: at(1), until: at(3))

            // SQLite は並びを決めていないので、時刻の順に並べてから比べる
            #expect(try records.findEntryTimesWrittenIn(window).sorted() == [at(1), at(2)])
            #expect(try ids(records.findJournalEntriesWrittenIn(window)) == [first.id, second.id])

            let calendar = try store.calendar(at(5), JournalMonth(year: 2026, month: 11)!)
            #expect(calendar.days[1] == .day(date: LocalDate(key: "2026-11-02")!, entries: 3))
            #expect(try ids(store.entriesOnDate(at(5), "2026-11-02").entries) == [first.id, second.id, third.id])
        }
    }
}

@Suite("タイムライン")
struct TimelineContractTests {
    @Test("開始の新しい順に進行中のセッションから1ページずつ返り、最後のページで続きがなくなる")
    func pages() throws {
        try freshStore { records in
            let store = Operator(records: records)
            let closed = try (0..<12).map { (i: Int64) in
                let started = try inSession(store.start(at(i * 10)).get())
                _ = try store.write(at(i * 10 + 1), "\(i + 1)つ目").get()
                _ = try store.operate(at(i * 10 + 2), .end).get()
                return started.session.id
            }
            let inProgress = try inSession(store.start(at(130)).get()).session.id
            let kept = try store.write(at(131), "残す").get()
            let removed = try store.write(at(131, 30), "消す").get()
            let later = try store.write(at(132), "あとで書いた").get()
            _ = try store.remove(at(133), removed.id).get()

            let latest = try store.timeline(at(134))
            #expect(latest.sessions.map(\.session.id) == [inProgress] + closed[3...].reversed())
            #expect(ids(latest.sessions[0].entries) == [kept.id, later.id])
            #expect(latest.next == .more(before: at(30)))

            let last = try store.timeline(at(135), before: at(30))
            #expect(last.sessions.map(\.session.id) == Array(closed[..<3].reversed()))
            #expect(last.next == .end)
        }
    }
}

@Suite("タグ")
struct TagContractTests {
    @Test("使っているタグは最近使った順、同じ時刻なら名前の順に並び、削除した記入のタグは数えない")
    func order() throws {
        try freshStore { records in
            let store = Operator(records: records)
            _ = try store.start(at(0)).get()
            _ = try store.write(at(1), "1", ["a", "b"]).get()
            _ = try store.write(at(2), "2", ["c", "b"]).get()
            let removed = try store.write(at(3), "3", ["d"]).get()
            _ = try store.remove(at(4), removed.id).get()
            // SQLite は名前を UTF-8 のバイト順で並べる。UTF-16 で比べると U+E000 と絵文字の順が逆になる
            _ = try store.write(at(5), "4", ["😀", "\u{E000}"]).get()

            #expect(try store.tagList(at(6)) == tags(["\u{E000}", "😀", "b", "c", "a"]))
            #expect(
                try store.tagUsage(at(6)) == [
                    TagUsage(name: tag("\u{E000}"), entryCount: 1), TagUsage(name: tag("😀"), entryCount: 1),
                    TagUsage(name: tag("b"), entryCount: 2), TagUsage(name: tag("c"), entryCount: 1),
                    TagUsage(name: tag("a"), entryCount: 1),
                ])
        }
    }

    @Test("削除した記入のタグは、使えるタグの種類の上限に数えない")
    func limitIgnoresDeleted() throws {
        try freshStore { records in
            let store = Operator(records: records)
            _ = try store.start(at(0)).get()
            let twenty = (1...20).map { "t\($0)" }
            let full = try store.write(at(1), "20種類", twenty).get()

            #expect(try failed(store.write(at(2), "21種類目", ["t21"])) == .tagLimitExceeded(TagLimitExceeded(limit: 20)))
            _ = try store.edit(at(3), full.id, "入れ替え", Array(twenty.dropFirst()) + ["t21"]).get()
            _ = try store.remove(at(4), full.id).get()
            #expect(try store.write(at(5), "空いた", ["t22"]).get().tags == [tag("t22")])
        }
    }

    @Test("タグを外すと、ついていた記入からだけ外れ、記入の更新時刻は変わらない")
    func detach() throws {
        try freshStore { records in
            let store = Operator(records: records)
            _ = try store.start(at(0)).get()
            let both = try store.write(at(1), "1", ["x", "y"]).get()
            let onlyY = try store.write(at(2), "2", ["y"]).get()
            let onlyX = try store.write(at(3), "3", ["x"]).get()

            _ = try store.deleteTag(at(4), "x", .detach).get()

            #expect(try store.tagList(at(5)) == [tag("y")])
            let entries = try store.timeline(at(5)).sessions.first?.entries ?? []
            #expect(entries.map(\.id) == [both.id, onlyY.id, onlyX.id])
            #expect(entries.map(\.tags) == [[tag("y")], [tag("y")], []])
            #expect(entries.map(\.updatedAt) == [at(1), at(2), at(3)])
        }
    }

    @Test("タグを付け替えると、付け替え先がすでについている記入では1つにまとまる")
    func reassign() throws {
        try freshStore { records in
            let store = Operator(records: records)
            _ = try store.start(at(0)).get()
            _ = try store.write(at(1), "1", ["x", "y"]).get()
            _ = try store.write(at(2), "2", ["x"]).get()
            _ = try store.write(at(3), "3", ["z"]).get()

            #expect(
                try failed(store.deleteTag(at(4), "x", .reassign(to: tag("unused"))))
                    == .tagNotFound(name: tag("unused")))
            _ = try store.deleteTag(at(5), "x", .reassign(to: tag("y"))).get()

            #expect(
                try store.tagUsage(at(6)) == [
                    TagUsage(name: tag("z"), entryCount: 1), TagUsage(name: tag("y"), entryCount: 2),
                ])
            #expect(try store.entriesWithTag(at(6), "y").entries.map(\.tags) == [[tag("y")], [tag("y")]])
        }
    }

    @Test("タグのついた記入は書いた時刻の新しい順に1ページずつ返り、最後のページで続きがなくなる")
    func taggedPages() throws {
        try freshStore { records in
            let store = Operator(records: records)
            _ = try store.start(at(0)).get()
            let tagged = try (1...22).map { (i: Int64) in try store.write(at(i), "\(i)", ["t"]).get() }
            let removed = try store.write(at(23), "消す", ["t"]).get()
            _ = try store.remove(at(24), removed.id).get()
            _ = try store.write(at(25), "タグなし").get()

            let latest = try store.entriesWithTag(at(26), "t")
            #expect(ids(latest.entries) == ids(tagged[2...].reversed()))
            #expect(latest.next == .more(before: at(3)))

            let last = try store.entriesWithTag(at(26), "t", before: at(3))
            #expect(ids(last.entries) == ids(tagged[..<2].reversed()))
            #expect(last.next == .end)
        }
    }
}

@Suite("スタッツ")
struct StatsContractTests {
    @Test("数えるもとの記録は削除した記入を除き、自動終了の判断に使う記入の時刻には含める")
    func records() throws {
        try freshStore { records in
            let store = Operator(records: records)
            let first = try inSession(store.start(at(0)).get()).session.id
            _ = try store.write(at(1), "残す", ["a"]).get()
            let removed = try store.write(at(2), "消す", ["b"]).get()
            _ = try store.remove(at(3), removed.id).get()
            _ = try store.operate(at(4), .end).get()
            let second = try inSession(store.start(at(10)).get()).session.id
            _ = try store.write(at(11), "進行中").get()

            let found = try records.findStatsRecords()
            // SQLite はセッションを ID の順に返す。順は数え方に影響しないので、開始の順に並べてから比べる
            let sessions = found.sessions.sorted { $0.events.start.event.at < $1.events.start.event.at }
            #expect(sessions.map(\.id) == [first, second])
            #expect(sessions.map(\.journalEntryTimes) == [[at(1), at(2)], [at(11)]])
            #expect(
                found.entries == [
                    EntryMark(sessionId: first, writtenAt: at(1), writtenDuring: .focus(round: 1, setNumber: 1), tags: [tag("a")]),
                    EntryMark(sessionId: second, writtenAt: at(11), writtenDuring: .focus(round: 1, setNumber: 1), tags: []),
                ])
            guard case .active(let active) = try store.stats(at(12)).activity else {
                Issue.record("記録があるのに活動なしになった")
                return
            }
            #expect(active.entries == 2)
        }
    }
}
