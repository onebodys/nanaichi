import Foundation
import Synchronization
import Testing

@testable import NanaichiDevice
@testable import NanaichiDomain
@testable import NanaichiWorkflows

// この Mac の記録をアカウントへ取り込む（ADR 0020）。Web の `device/device-import.test.ts` と
// `client/import-driver.test.ts` の場面を、SQLite の記録先と Swift のワークフローに当てはめたもの

/// 1つのセッションを始め、記入を書き、終了する。終わった時刻は始めてから `minutes` 分後
private func recordClosedSession(
    _ backend: DeviceBackend, _ clock: TestClock, minutes: Int64 = 3, entries: [String] = ["読書をした"]
) async throws -> SessionId {
    let (session, _) = try inSession(try await backend.startSession(id: eventId()).get())
    for body in entries {
        clock.advance(minute)
        _ = try await backend.writeJournalEntry(id: entryId(), body: body, tags: [tag("読書")]).get()
    }
    clock.advance((minutes - Int64(entries.count)) * minute)
    _ = try await backend.operateSession(id: eventId(), kind: .end).get()
    clock.advance(minute)
    return session.id
}

@Suite("この Mac の取り込める記録")
struct DeviceImportTests {
    @Test("取り込めるのは閉じたセッションだけで、開いたままのセッションがあれば残っていると返す")
    func onlyClosedSessions() async throws {
        let clock = TestClock()
        let backend = DeviceBackend(location: .inMemory, clock: { clock.now })
        let closedId = try await recordClosedSession(backend, clock)
        _ = try await backend.startSession(id: eventId()).get()

        let records = try await backend.loadImportable().get()

        #expect(records.sessions.map(\.id) == [closedId])
        #expect(records.open == .openSessionLeft)
        #expect(Import.summaryOf(records.sessions) == ImportSummary(sessions: 1, entries: 1))
    }

    @Test("削除した記入は本文を送らず、削除の印と書いた時刻とセッションを送る")
    func deletedEntriesAsMarks() async throws {
        let clock = TestClock()
        let backend = DeviceBackend(location: .inMemory, clock: { clock.now })
        let (session, _) = try inSession(try await backend.startSession(id: eventId()).get())
        clock.advance(minute)
        let kept = try await backend.writeJournalEntry(id: entryId(), body: "残す記入", tags: [tag("読書")]).get()
        clock.advance(minute)
        let removed = try await backend.writeJournalEntry(id: entryId(), body: "消す記入", tags: []).get()
        clock.advance(minute)
        let deleted = try await backend.deleteJournalEntry(id: removed.id).get()
        _ = try await backend.operateSession(id: eventId(), kind: .end).get()

        let records = try await backend.loadImportable().get()

        #expect(
            records.sessions.first?.entries == [
                .written(kept), .deleted(deleted, sessionId: session.id, writtenAt: removed.writtenAt),
            ])
        #expect(records.open == .noOpenSession)
    }

    @Test("自動終了の時刻を過ぎて開いていたセッションは、閉じてから取り込める記録に入る")
    func autoEndedSessionIsImportable() async throws {
        let clock = TestClock()
        let backend = DeviceBackend(location: .inMemory, clock: { clock.now })
        let (session, _) = try inSession(try await backend.startSession(id: eventId()).get())
        clock.advance(day)

        let records = try await backend.loadImportable().get()

        #expect(records.sessions.map(\.id) == [session.id])
        #expect(records.sessions.first?.endedBy == .autoEnd)
        #expect(records.open == .noOpenSession)
    }

    @Test("フェーズの進め方の変更履歴は全部を時刻の順に送る")
    func advanceModeChanges() async throws {
        let clock = TestClock()
        let backend = DeviceBackend(location: .inMemory, clock: { clock.now })
        _ = try await backend.changeAdvanceMode(mode(.manual, .auto)).get()
        clock.advance(minute)
        _ = try await backend.changeAdvanceMode(mode(.manual, .manual)).get()

        let records = try await backend.loadImportable().get()

        #expect(records.advanceModeChanges.map(\.mode) == [mode(.manual, .auto), mode(.manual, .manual)])
    }

    @Test("指定した閉じたセッションだけを、記入とタグごと消し、進め方の履歴は残す")
    func removesOnlyGivenClosedSessions() async throws {
        let clock = TestClock()
        let database = TemporaryDatabase()
        let backend = database.backend(clock)
        _ = try await backend.changeAdvanceMode(mode(.manual, .auto)).get()
        let first = try await recordClosedSession(backend, clock)
        let second = try await recordClosedSession(backend, clock)

        _ = try await backend.removeClosedSessions([first]).get()

        let records = try await backend.loadImportable().get()
        #expect(records.sessions.map(\.id) == [second])
        #expect(records.advanceModeChanges.count == 1)
        let orphans = try await database.connection().read { db in
            try Int.fetchOne(
                db,
                sql: """
                    SELECT (SELECT COUNT(*) FROM journal_entry_tags WHERE entry_id NOT IN (SELECT id FROM journal_entries))
                      + (SELECT COUNT(*) FROM session_events WHERE session_id NOT IN (SELECT id FROM sessions))
                    """)
        }
        #expect(orphans == 0)
        #expect(try await backend.getTags().get().tags == [tag("読書")])
    }

    @Test("開いているセッションやない ID を指定しても何も消さず、失敗もしない")
    func ignoresOpenAndUnknownIds() async throws {
        let clock = TestClock()
        let backend = DeviceBackend(location: .inMemory, clock: { clock.now })
        let closedId = try await recordClosedSession(backend, clock)
        let (open, _) = try inSession(try await backend.startSession(id: eventId()).get())

        _ = try await backend.removeClosedSessions([open.id, sessionId()]).get()

        #expect(try await backend.loadImportable().get().sessions.map(\.id) == [closedId])
        #expect(isOpen(try await backend.getCurrentSession().get(), open.id))
    }
}

private func isOpen(_ snapshot: SessionSnapshot, _ id: SessionId) -> Bool {
    guard case .session(_, let session, _) = snapshot else { return false }
    return session.id == id
}

// MARK: - 取り込みの流れ

/// アカウントの代わり。受け取ったセッションを覚え、同じ ID なら AlreadyImported、`overlapping` なら Overlapping を返す。
/// `failures` に入れた失敗を、送られた順に1つずつ返す
private final class FakeAccount: Sendable {
    private struct State {
        var imported: Set<SessionId> = []
        var failures: [ImportCallError] = []
        var sent: [[SessionId]] = []
        var waited: [Int] = []
    }

    private let state = Mutex(State())
    let overlapping: Set<SessionId>

    init(overlapping: Set<SessionId> = [], failures: [ImportCallError] = []) {
        self.overlapping = overlapping
        state.withLock { $0.failures = failures }
    }

    var imported: Set<SessionId> { state.withLock { $0.imported } }
    var sent: [[SessionId]] { state.withLock { $0.sent } }
    var waited: [Int] { state.withLock { $0.waited } }

    func send(_ batch: ImportBatch) -> Result<ImportReceipt, ImportCallError> {
        state.withLock { state in
            state.sent.append(batch.sessions.map(\.id))
            if !state.failures.isEmpty { return .failure(state.failures.removeFirst()) }
            let outcomes = batch.sessions.map { session in
                if overlapping.contains(session.id) { return SessionImportOutcome(sessionId: session.id, kind: .overlapping) }
                let kind: SessionImportOutcomeKind = state.imported.contains(session.id) ? .alreadyImported : .imported
                state.imported.insert(session.id)
                return SessionImportOutcome(sessionId: session.id, kind: kind)
            }
            return .success(ImportReceipt(outcomes: outcomes))
        }
    }

    func wait(_ milliseconds: Int) { state.withLock { $0.waited.append(milliseconds) } }
}

private func deps(
    _ backend: DeviceBackend, _ account: FakeAccount,
    remove: (@Sendable ([SessionId]) async -> Result<Void, BackendError>)? = nil
) -> ImportDeps {
    ImportDeps(
        load: { await backend.loadImportable() },
        remove: remove ?? { await backend.removeClosedSessions($0) },
        send: { account.send($0) },
        wait: { account.wait($0) },
        onProgress: { _ in })
}

@Suite("この Mac の記録をアカウントへ取り込む")
struct RunImportTests {
    @Test("閉じたセッションをすべて送り、アカウントに入った分をこの Mac から消す")
    func importsAndRemoves() async throws {
        let clock = TestClock()
        let backend = DeviceBackend(location: .inMemory, clock: { clock.now })
        let first = try await recordClosedSession(backend, clock)
        let second = try await recordClosedSession(backend, clock)
        let account = FakeAccount()

        let result = try await runImport(deps(backend, account)).get()

        #expect(result == ImportResult(imported: 2, overlapping: 0, open: .noOpenSession))
        #expect(account.imported == [first, second])
        #expect(try await backend.loadImportable().get().sessions.isEmpty)
    }

    @Test("時間が重なったセッションはこの Mac に残し、その数を返す")
    func keepsOverlapping() async throws {
        let clock = TestClock()
        let backend = DeviceBackend(location: .inMemory, clock: { clock.now })
        let first = try await recordClosedSession(backend, clock)
        let second = try await recordClosedSession(backend, clock)
        let account = FakeAccount(overlapping: [second])

        let result = try await runImport(deps(backend, account)).get()

        #expect(result == ImportResult(imported: 1, overlapping: 1, open: .noOpenSession))
        #expect(account.imported == [first])
        #expect(try await backend.loadImportable().get().sessions.map(\.id) == [second])
    }

    @Test("通信が切れたら止まって何も消さず、やり直すと同じ結果になる")
    func retryAfterUnreachable() async throws {
        let clock = TestClock()
        let backend = DeviceBackend(location: .inMemory, clock: { clock.now })
        let first = try await recordClosedSession(backend, clock)
        let account = FakeAccount(failures: [.backend(.unreachable)])

        #expect(try failed(await runImport(deps(backend, account))) == .backend(.unreachable))
        #expect(try await backend.loadImportable().get().sessions.map(\.id) == [first])

        let retried = try await runImport(deps(backend, account)).get()
        #expect(retried.imported == 1)
        #expect(account.imported == [first])
        #expect(try await backend.loadImportable().get().sessions.isEmpty)
    }

    @Test("この Mac から消せなかったら止まり、やり直すとアカウントにすでにあるので消える（二重に取り込まない）")
    func retryAfterRemoveFailed() async throws {
        let clock = TestClock()
        let backend = DeviceBackend(location: .inMemory, clock: { clock.now })
        let first = try await recordClosedSession(backend, clock)
        let account = FakeAccount()

        let failedRemove = deps(backend, account, remove: { _ in .failure(.storageFailed(.unavailable)) })
        #expect(try failed(await runImport(failedRemove)) == .backend(.storageFailed(.unavailable)))
        #expect(try await backend.loadImportable().get().sessions.map(\.id) == [first])

        let retried = try await runImport(deps(backend, account)).get()
        #expect(retried == ImportResult(imported: 1, overlapping: 0, open: .noOpenSession))
        #expect(account.sent == [[first], [first]])
        #expect(account.imported == [first])
        #expect(try await backend.loadImportable().get().sessions.isEmpty)
    }

    @Test("送りすぎ（429）なら Retry-After だけ待って同じ束を送り直し、6回続いたら諦める")
    func rateLimited() async throws {
        let clock = TestClock()
        let backend = DeviceBackend(location: .inMemory, clock: { clock.now })
        let first = try await recordClosedSession(backend, clock)

        let patient = FakeAccount(failures: [.rateLimited(retryAfterMs: 10_000), .rateLimited(retryAfterMs: 5_000)])
        #expect(try await runImport(deps(backend, patient)).get().imported == 1)
        #expect(patient.waited == [10_000, 5_000])
        #expect(patient.sent == [[first], [first], [first]])

        let secondId = try await recordClosedSession(backend, clock)
        let busy = FakeAccount(failures: Array(repeating: .rateLimited(retryAfterMs: 10_000), count: 6))
        #expect(try failed(await runImport(deps(backend, busy))) == .rateLimitedTooLong)
        #expect(busy.waited.count == 5)
        #expect(try await backend.loadImportable().get().sessions.map(\.id) == [secondId])
    }

    @Test("開いたままのセッションは送らず、残っていると返す")
    func reportsOpenSession() async throws {
        let clock = TestClock()
        let backend = DeviceBackend(location: .inMemory, clock: { clock.now })
        _ = try await recordClosedSession(backend, clock)
        let (open, _) = try inSession(try await backend.startSession(id: eventId()).get())
        let account = FakeAccount()

        let result = try await runImport(deps(backend, account)).get()

        #expect(result.open == .openSessionLeft)
        #expect(!account.imported.contains(open.id))
        #expect(isOpen(try await backend.getCurrentSession().get(), open.id))
    }
}
