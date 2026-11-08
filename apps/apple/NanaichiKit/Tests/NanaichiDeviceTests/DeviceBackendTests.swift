import Foundation
import GRDB
import Testing

@testable import NanaichiDevice
@testable import NanaichiDomain

// Web の `apps/web/src/device/device-backend.test.ts` のうち、SQLite の記録先に当てはまる場面。
// タブの間のロックと BroadcastChannel、persist() はブラウザに固有なので移さない（ADR 0028）

private func isSession(_ result: Result<SessionSnapshot, BackendError>) -> Bool {
    guard case .success(.session) = result else { return false }
    return true
}

private func tagsOfEntries(_ backend: DeviceBackend) async throws -> [[TagName]] {
    try await backend.getTimeline(before: nil).get().sessions.flatMap { $0.entries.map(\.tags) }
}

@Suite("この端末の記録先")
struct DeviceBackendTests {
    @Test("開始すると記録され、記録先を開き直しても残っている")
    func persists() async throws {
        let database = TemporaryDatabase()
        #expect(try await database.backend().getCurrentSession().get() == .noSession(serverTime: T0))

        _ = try await database.backend().startSession(id: eventId()).get()

        let reopened = database.backend()
        #expect(isSession(await reopened.getCurrentSession()))
        let id = entryId()
        _ = try await reopened.writeJournalEntry(id: id, body: "読書をした", tags: []).get()
        let page = try await database.backend().getTimeline(before: nil).get()
        #expect(page.sessions.flatMap { $0.entries.map(\.id) } == [id])
    }

    @Test("2つの画面から同時に開始してもセッションは1つ")
    func concurrentStart() async throws {
        let backend = DeviceBackend(location: .inMemory, clock: { T0 })
        async let first = backend.startSession(id: eventId())
        async let second = backend.startSession(id: eventId())
        let results = await [first, second]

        #expect(results.filter(isSession).count == 1)
        #expect(results.contains { $0 == .failure(.rejected(.sessionAlreadyInProgress)) })
    }

    @Test("受け取り始めるとまず繋がったと知らせ、書いたあとは受け取っているすべての画面に同期メッセージが届く")
    func syncMessages() async throws {
        let backend = DeviceBackend(location: .inMemory, clock: { T0 })
        var menuBar = await backend.subscribe().makeAsyncIterator()
        var window = await backend.subscribe().makeAsyncIterator()

        let snapshot = try await backend.startSession(id: eventId()).get()

        #expect(await menuBar.next() == .connected)
        #expect(await menuBar.next() == .message(.sessionChanged(snapshot)))
        #expect(await window.next() == .connected)
        #expect(await window.next() == .message(.sessionChanged(snapshot)))
    }

    @Test("受け取るのをやめると、そのあとの同期メッセージは届かない")
    func stopReceiving() async throws {
        let backend = DeviceBackend(location: .inMemory, clock: { T0 })
        let stream = await backend.subscribe()
        let receiving = Task {
            var received: [SyncEvent] = []
            for await event in stream { received.append(event) }
            return received
        }
        receiving.cancel()
        #expect(await receiving.value.allSatisfy { $0 == .connected })

        _ = try await backend.startSession(id: eventId()).get()
        var after = stream.makeAsyncIterator()
        #expect(await after.next() == nil)
    }

    @Test("想定内の失敗は Rejected で返し、そのとき確定した自動終了は保存する")
    func rejectedKeepsAutoEnd() async throws {
        let database = TemporaryDatabase()
        let clock = TestClock()
        let backend = database.backend(clock)
        _ = try await backend.startSession(id: eventId()).get()
        clock.advance(day)

        #expect(await backend.operateSession(id: eventId(), kind: .pause) == .failure(.rejected(.noSessionInProgress)))
        let endedBy = try await database.connection().read { try String.fetchOne($0, sql: "SELECT ended_by FROM sessions") }
        #expect(endedBy == "AutoEnd")
    }

    @Test("タグの削除の途中で書き込みに失敗したら、どの記入も書き換えず、何も知らせない")
    func midWorkflowFailureWritesNothing() async throws {
        let database = TemporaryDatabase()
        let clock = TestClock()
        let backend = database.backend(clock)
        _ = try await backend.startSession(id: eventId()).get()
        clock.advance(minute)
        _ = try await backend.writeJournalEntry(id: entryId(), body: "1", tags: tags(["x", "y"])).get()
        clock.advance(minute)
        let later = try await backend.writeJournalEntry(id: entryId(), body: "2", tags: tags(["x"])).get()
        // 2件目の記入のタグを書き直すときに、SQLite が書き込みを断るようにする
        try await database.connection().write { db in
            try db.execute(
                sql: """
                    CREATE TRIGGER fail_second_entry BEFORE DELETE ON journal_entry_tags
                    WHEN OLD.entry_id = '\(later.id.rawValue)'
                    BEGIN SELECT RAISE(ABORT, '書き込みに失敗した'); END
                    """)
        }
        var events = await backend.subscribe().makeAsyncIterator()
        #expect(await events.next() == .connected)

        #expect(await backend.deleteTag(name: tag("x"), deletion: .detach) == .failure(.broken))

        #expect(try await tagsOfEntries(backend) == [tags(["x", "y"]), tags(["x"])])
        #expect(try await backend.getTags().get().tags.contains(tag("x")))
        _ = try await backend.changeAdvanceMode(mode(.manual, .auto)).get()
        #expect(await events.next() == .message(.advanceModeChanged(mode(.manual, .auto))))
    }

    @Test("SQLite でないファイルは読めないとして、上書きしない")
    func notADatabase() async throws {
        let database = TemporaryDatabase()
        try Data("これは SQLite のファイルではない".utf8).write(to: database.url)
        let before = try database.bytes()
        let backend = database.backend()

        #expect(await backend.getCurrentSession() == .failure(.broken))
        #expect(await backend.startSession(id: eventId()) == .failure(.broken))
        #expect(await backend.deleteJournalEntry(id: entryId()) == .failure(.broken))
        #expect(try database.bytes() == before)
    }

    @Test("読めない行がある記録は上書きせず、その行を残したまま Broken を返す")
    func unreadableRow() async throws {
        let database = TemporaryDatabase()
        _ = try await database.backend().startSession(id: eventId()).get()
        try await database.connection().write { try $0.execute(sql: "UPDATE sessions SET started_at = '壊れた時刻'") }

        let backend = database.backend()
        #expect(await backend.getCurrentSession() == .failure(.broken))
        #expect(await backend.startSession(id: eventId()) == .failure(.broken))
        #expect(await backend.getTimeline(before: nil) == .failure(.broken))

        let rows = try await database.connection().read { db in
            try (
                String.fetchAll(db, sql: "SELECT started_at FROM sessions"),
                Int.fetchOne(db, sql: "SELECT COUNT(*) FROM session_events")
            )
        }
        #expect(rows.0 == ["壊れた時刻"])
        #expect(rows.1 == 1)
    }

    @Test("新しい版のアプリが書いた記録は、読みも書きもせず NewerFormat を返す")
    func newerFormat() async throws {
        let database = TemporaryDatabase()
        _ = try await database.backend().startSession(id: eventId()).get()
        try await database.connection().write { try $0.execute(sql: "INSERT INTO grdb_migrations (identifier) VALUES ('v999')") }
        let before = try database.bytes()
        let backend = database.backend()

        #expect(await backend.getCurrentSession() == .failure(.storageFailed(.newerFormat)))
        #expect(await backend.startSession(id: eventId()) == .failure(.storageFailed(.newerFormat)))
        #expect(try database.bytes() == before)
    }

    @Test("時計が戻っても操作でき、記録済みのいちばん新しい時刻で記録する")
    func clockGoesBack() async throws {
        let clock = TestClock()
        let backend = DeviceBackend(location: .inMemory, clock: { clock.now })
        clock.advance(10 * minute)
        _ = try await backend.startSession(id: eventId()).get()
        clock.advance(-10 * minute)

        let paused = try await backend.operateSession(id: eventId(), kind: .pause).get()
        guard case .session(let serverTime, _, let state) = paused else {
            Issue.record("一時停止したのにセッションがない")
            return
        }
        #expect(state.kind == .focus)
        #expect(serverTime == at(10))
    }
}
