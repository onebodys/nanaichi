import GRDB
import NanaichiDomain
import NanaichiWorkflows

/// 読み書きの契約（ドメインの `SessionStore` ほか）を、この端末の SQLite で実装する。
///
/// クエリは UserDO の SQLite のアダプタ（`apps/web/src/server/*-sqlite.ts`）と同じにする。
/// 1つのワークフローの間だけ、書き込みのトランザクションの中の `db` で使う（`DeviceBackend`）
struct SQLiteRecords {
    let db: Database
}

// MARK: - 行をドメインの型にする

private let journalEntryColumns = """
    id, session_id, body, written_at, updated_at, round, set_number, phase, deleted_at,
      (SELECT json_group_array(name) FROM
         (SELECT name FROM journal_entry_tags WHERE entry_id = journal_entries.id ORDER BY position)
      ) AS tags
    """

private enum PhaseColumn: String {
    case focus = "Focus"
    case journal = "Journal"
    case breakTime = "Break"
}

/// 紐付きの列（`round` / `set_number` / `phase`）を、書いた時点のタイマーの状態の型に戻す。
/// 休憩中はセット番号がなく、待機中はフェーズがない。それ以外の組み合わせは記録が壊れている
private func writtenDuring(_ reader: RowReader) throws -> WrittenDuring {
    let round = try reader.positiveInt("round")
    let setNumber = try reader.optionalPositiveInt("set_number")
    let phase = try reader.optionalText("phase").map { text in
        guard let phase = PhaseColumn(rawValue: text) else { throw UnreadableRecord(table: reader.table, column: "phase") }
        return phase
    }
    switch (phase, setNumber) {
    case (.breakTime, nil): return .breakTime(round: round)
    case (.focus, let setNumber?): return .focus(round: round, setNumber: setNumber)
    case (.journal, let setNumber?): return .journal(round: round, setNumber: setNumber)
    case (nil, let setNumber?): return .idle(round: round, setNumber: setNumber)
    case (.breakTime, .some), (.focus, nil), (.journal, nil), (nil, nil):
        throw UnreadableRecord(table: reader.table, column: "set_number")
    }
}

/// 紐付きを列に書く形にする
private func columns(of writtenDuring: WrittenDuring) -> (round: Int, setNumber: Int?, phase: String?) {
    switch writtenDuring {
    case .focus(let round, let setNumber): (round, setNumber, PhaseColumn.focus.rawValue)
    case .journal(let round, let setNumber): (round, setNumber, PhaseColumn.journal.rawValue)
    case .breakTime(let round): (round, nil, PhaseColumn.breakTime.rawValue)
    case .idle(let round, let setNumber): (round, setNumber, nil)
    }
}

private func storedJournalEntry(_ row: Row) throws -> StoredJournalEntry {
    let reader = RowReader(row: row, table: "journal_entries")
    let id = try reader.parsed("id", JournalEntryId.init)
    // 本文は削除した記入にも残るが、読めることは同じく確かめる（UserDO と同じ）
    let body = try reader.parsed("body", JournalEntryBody.init)
    let tags = try reader.tags("tags")
    if let deletedAt = try reader.optionalInstant("deleted_at") {
        return .deleted(DeletedJournalEntry(id: id, deletedAt: deletedAt))
    }
    return .written(
        JournalEntry(
            id: id, sessionId: try reader.parsed("session_id", SessionId.init), body: body, tags: tags,
            writtenAt: try reader.instant("written_at"), updatedAt: try reader.instant("updated_at"),
            writtenDuring: try writtenDuring(reader)))
}

private func writtenEntries(_ rows: [Row]) throws -> [JournalEntry] {
    try rows.compactMap { row in
        switch try storedJournalEntry(row) {
        case .written(let entry): entry
        case .deleted: nil
        }
    }
}

private func advanceModeChange(_ row: Row) throws -> AdvanceModeChange {
    let reader = RowReader(row: row, table: "advance_mode_changes")
    func choice(_ column: String) throws -> AdvanceChoice { try reader.parsed(column, AdvanceChoice.init) }
    return AdvanceModeChange(
        at: try reader.instant("changed_at"),
        mode: AdvanceMode(
            focusToJournal: try choice("focus_to_journal"), journalToFocus: try choice("journal_to_focus"),
            journalToBreak: try choice("journal_to_break"), breakToFocus: try choice("break_to_focus")))
}

private enum EventKind {
    case start
    case operation(SessionOperationKind)

    init?(_ text: String) {
        if text == "Start" {
            self = .start
        } else if let kind = SessionOperationKind(rawValue: text) {
            self = .operation(kind)
        } else {
            return nil
        }
    }
}

/// 1つのセッションの操作イベントの行（時刻の順）を、開始から始まる操作イベントにする
private func recordedEvents(_ rows: [Row]) throws -> RecordedSessionEvents {
    let events = try rows.map { row in
        let reader = RowReader(row: row, table: "session_events")
        return (
            id: try reader.parsed("id", SessionEventId.init), kind: try reader.parsed("kind", EventKind.init),
            at: try reader.instant("at")
        )
    }
    guard let first = events.first, case .start = first.kind else {
        throw UnreadableRecord(table: "session_events", column: "kind")
    }
    let operations = try events.dropFirst().map { event in
        switch event.kind {
        case .operation(let kind): RecordedSessionEvent(id: event.id, event: SessionOperation(kind: kind, at: event.at))
        case .start: throw UnreadableRecord(table: "session_events", column: "kind")
        }
    }
    return RecordedSessionEvents(
        start: RecordedSessionEvent(id: first.id, event: Start(at: first.at)), operations: operations)
}

// MARK: - 読み込みの部品

extension SQLiteRecords {
    /// フェーズの進め方の変更履歴を時刻の順に読む（ADR 0016）。同じミリ秒の変更は記録した順
    private func advanceModeChanges() throws -> [AdvanceModeChange] {
        try Row.fetchAll(
            db,
            sql: """
                SELECT changed_at, focus_to_journal, journal_to_focus, journal_to_break, break_to_focus
                FROM advance_mode_changes ORDER BY changed_at, rowid
                """
        ).map(advanceModeChange)
    }

    /// 記録されているセッションを、操作イベントと記入の時刻と、計算に要る進め方の変更とともに読み込む
    private func loadSession(_ id: SessionId) throws -> Session {
        guard let span = try Row.fetchOne(db, sql: "SELECT started_at, ended_at FROM sessions WHERE id = ?", arguments: [id.rawValue])
        else { throw UnreadableRecord(table: "sessions", column: "id") }
        let reader = RowReader(row: span, table: "sessions")
        let startedAt = try reader.instant("started_at")
        let endedAt = try reader.optionalInstant("ended_at")
        return Session(
            id: id,
            // 同じミリ秒の操作は記録した順（rowid）に並べる
            events: try recordedEvents(
                Row.fetchAll(
                    db, sql: "SELECT id, kind, at FROM session_events WHERE session_id = ? ORDER BY at, rowid",
                    arguments: [id.rawValue])),
            // 削除した記入も、書いたことには変わりないので自動終了の判断に含める
            journalEntryTimes: try Row.fetchAll(
                db, sql: "SELECT written_at FROM journal_entries WHERE session_id = ? ORDER BY written_at",
                arguments: [id.rawValue]
            ).map { try RowReader(row: $0, table: "journal_entries").instant("written_at") },
            advanceModeChanges: AdvanceModeChange.relevantSince(try advanceModeChanges(), startedAt).filter { change in
                endedAt.map { change.at <= $0 } ?? true
            })
    }

    private func sessionId(_ row: Row?) throws -> SessionId? {
        try row.map { try RowReader(row: $0, table: "sessions").parsed("id", SessionId.init) }
    }

    private func writtenEntriesOf(_ sessionId: SessionId) throws -> [JournalEntry] {
        try writtenEntries(
            Row.fetchAll(
                db,
                sql: """
                    SELECT \(journalEntryColumns) FROM journal_entries
                    WHERE session_id = ? AND deleted_at IS NULL ORDER BY written_at
                    """, arguments: [sessionId.rawValue]))
    }

    private func tagNames(_ sql: String, _ arguments: StatementArguments = []) throws -> [TagName] {
        try Row.fetchAll(db, sql: sql, arguments: arguments).map {
            try RowReader(row: $0, table: "journal_entry_tags").parsed("name", TagName.init)
        }
    }

    /// 記入のタグを、つけた順に書き直す
    private func saveTags(_ entry: JournalEntry) throws {
        try db.execute(sql: "DELETE FROM journal_entry_tags WHERE entry_id = ?", arguments: [entry.id.rawValue])
        for (position, name) in entry.tags.enumerated() {
            try db.execute(
                sql: "INSERT INTO journal_entry_tags (entry_id, position, name) VALUES (?, ?, ?)",
                arguments: [entry.id.rawValue, position, name.rawValue])
        }
    }

    /// 記録済みのいちばん新しい時刻（端末の時計が戻ったときに使う、ADR 0019）。記録がなければ nil
    func latestRecordedAt() throws -> Instant? {
        try Int64.fetchOne(
            db,
            sql: """
                SELECT MAX(t) FROM (
                  SELECT MAX(at) AS t FROM session_events
                  UNION ALL SELECT MAX(ended_at) FROM sessions
                  UNION ALL SELECT MAX(MAX(written_at), MAX(updated_at), COALESCE(MAX(deleted_at), 0)) FROM journal_entries
                  UNION ALL SELECT MAX(changed_at) FROM advance_mode_changes
                )
                """
        ).map(Instant.init(milliseconds:))
    }
}

// MARK: - 読み書きの契約

extension SQLiteRecords: SessionStore {
    func findOpenSession() throws -> Session? {
        try sessionId(Row.fetchOne(db, sql: "SELECT id FROM sessions WHERE ended_at IS NULL")).map(loadSession)
    }

    func findSessionByEventId(_ eventId: SessionEventId) throws -> Session? {
        try sessionId(
            Row.fetchOne(db, sql: "SELECT session_id AS id FROM session_events WHERE id = ?", arguments: [eventId.rawValue])
        ).map(loadSession)
    }

    func saveStartedSession(_ session: Session) throws {
        let start = session.events.start
        try db.execute(
            sql: "INSERT INTO sessions (id, started_at) VALUES (?, ?)",
            arguments: [session.id.rawValue, start.event.at.milliseconds])
        try db.execute(
            sql: "INSERT INTO session_events (id, session_id, kind, at) VALUES (?, ?, 'Start', ?)",
            arguments: [start.id.rawValue, session.id.rawValue, start.event.at.milliseconds])
    }

    func appendSessionOperation(_ sessionId: SessionId, _ operation: RecordedSessionEvent<SessionOperation>) throws {
        try db.execute(
            sql: "INSERT INTO session_events (id, session_id, kind, at) VALUES (?, ?, ?, ?)",
            arguments: [
                operation.id.rawValue, sessionId.rawValue, operation.event.kind.rawValue,
                operation.event.at.milliseconds,
            ])
    }

    func closeSession(_ sessionId: SessionId, _ ended: TimerState.Ended) throws {
        try db.execute(
            sql: "UPDATE sessions SET ended_at = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL",
            arguments: [ended.endedAt.milliseconds, ended.endedBy.rawValue, sessionId.rawValue])
    }
}

extension SQLiteRecords: AdvanceModeStore {
    func loadAdvanceModeChanges() throws -> [AdvanceModeChange] { try advanceModeChanges() }

    func saveAdvanceModeChange(_ change: AdvanceModeChange) throws {
        try db.execute(
            sql: """
                INSERT INTO advance_mode_changes
                  (changed_at, focus_to_journal, journal_to_focus, journal_to_break, break_to_focus)
                VALUES (?, ?, ?, ?, ?)
                """,
            arguments: [
                change.at.milliseconds, change.mode.focusToJournal.rawValue, change.mode.journalToFocus.rawValue,
                change.mode.journalToBreak.rawValue, change.mode.breakToFocus.rawValue,
            ])
    }
}

extension SQLiteRecords: JournalEntryStore {
    func findJournalEntry(_ id: JournalEntryId) throws -> StoredJournalEntry? {
        try Row.fetchOne(db, sql: "SELECT \(journalEntryColumns) FROM journal_entries WHERE id = ?", arguments: [id.rawValue])
            .map(storedJournalEntry)
    }

    func saveJournalEntry(_ entry: JournalEntry) throws {
        let (round, setNumber, phase) = columns(of: entry.writtenDuring)
        try db.execute(
            sql: """
                INSERT INTO journal_entries (id, session_id, body, written_at, round, set_number, phase, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
            arguments: [
                entry.id.rawValue, entry.sessionId.rawValue, entry.body.unwrap(), entry.writtenAt.milliseconds,
                round, setNumber, phase, entry.updatedAt.milliseconds,
            ])
        try saveTags(entry)
    }

    func saveEditedJournalEntry(_ entry: JournalEntry) throws {
        try db.execute(
            sql: "UPDATE journal_entries SET body = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            arguments: [entry.body.unwrap(), entry.updatedAt.milliseconds, entry.id.rawValue])
        try saveTags(entry)
    }

    func deleteJournalEntry(_ deleted: DeletedJournalEntry) throws {
        try db.execute(
            sql: "UPDATE journal_entries SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
            arguments: [deleted.deletedAt.milliseconds, deleted.id.rawValue])
    }

    func listTagsOfOtherEntries(_ id: JournalEntryId) throws -> [TagName] {
        try tagNames(
            """
            SELECT DISTINCT t.name FROM journal_entry_tags t
            JOIN journal_entries e ON e.id = t.entry_id
            WHERE e.deleted_at IS NULL AND e.id != ?
            """, [id.rawValue])
    }

    func listJournalEntriesTaggedWith(_ name: TagName) throws -> [JournalEntry] {
        try writtenEntries(
            Row.fetchAll(
                db,
                sql: """
                    SELECT \(journalEntryColumns) FROM journal_entries
                    WHERE deleted_at IS NULL
                      AND id IN (SELECT entry_id FROM journal_entry_tags WHERE name = ?)
                    ORDER BY written_at
                    """, arguments: [name.rawValue]))
    }

    func saveJournalEntryTags(_ entry: JournalEntry) throws { try saveTags(entry) }
}

extension SQLiteRecords: TagStore {
    func listTagsInUse() throws -> [TagName] {
        try tagNames(
            """
            SELECT t.name FROM journal_entry_tags t
            JOIN journal_entries e ON e.id = t.entry_id
            WHERE e.deleted_at IS NULL
            GROUP BY t.name ORDER BY MAX(e.written_at) DESC, t.name
            """)
    }

    // 1件の記入に同じタグは1つしかつかない（`Tags`）ので、行の数がそのまま記入の数になる
    func listTagUsage() throws -> [TagUsage] {
        try Row.fetchAll(
            db,
            sql: """
                SELECT t.name, COUNT(*) AS entry_count FROM journal_entry_tags t
                JOIN journal_entries e ON e.id = t.entry_id
                WHERE e.deleted_at IS NULL
                GROUP BY t.name ORDER BY MAX(e.written_at) DESC, t.name
                """
        ).map { row in
            let reader = RowReader(row: row, table: "journal_entry_tags")
            return TagUsage(name: try reader.parsed("name", TagName.init), entryCount: try reader.positiveInt("entry_count"))
        }
    }
}

extension SQLiteRecords: TimelineStore {
    func findTimelineSessions(_ range: TimelineRange) throws -> [TimelineSession] {
        let rows =
            switch range {
            case .latest(let limit):
                try Row.fetchAll(db, sql: "SELECT id FROM sessions ORDER BY started_at DESC LIMIT ?", arguments: [limit])
            case .before(let before, let limit):
                try Row.fetchAll(
                    db, sql: "SELECT id FROM sessions WHERE started_at < ? ORDER BY started_at DESC LIMIT ?",
                    arguments: [before.milliseconds, limit])
            }
        return try rows.compactMap(sessionId).map { id in
            TimelineSession(session: try loadSession(id), entries: try writtenEntriesOf(id))
        }
    }
}

extension SQLiteRecords: JournalCalendarStore {
    func findEntryTimesWrittenIn(_ window: WrittenWindow) throws -> [Instant] {
        try Row.fetchAll(
            db,
            sql: """
                SELECT written_at FROM journal_entries
                WHERE deleted_at IS NULL AND written_at >= ? AND written_at < ?
                """, arguments: [window.from.milliseconds, window.until.milliseconds]
        ).map { try RowReader(row: $0, table: "journal_entries").instant("written_at") }
    }

    func findJournalEntriesWrittenIn(_ window: WrittenWindow) throws -> [JournalEntry] {
        try writtenEntries(
            Row.fetchAll(
                db,
                sql: """
                    SELECT \(journalEntryColumns) FROM journal_entries
                    WHERE deleted_at IS NULL AND written_at >= ? AND written_at < ? ORDER BY written_at
                    """, arguments: [window.from.milliseconds, window.until.milliseconds]))
    }
}

extension SQLiteRecords: TaggedEntriesStore {
    func findJournalEntriesWithTag(_ range: TaggedEntriesRange) throws -> [JournalEntry] {
        let tagged = """
            SELECT \(journalEntryColumns) FROM journal_entries
            WHERE deleted_at IS NULL
              AND id IN (SELECT entry_id FROM journal_entry_tags WHERE name = ?)
            """
        let rows =
            switch range {
            case .latest(let tag, let limit):
                try Row.fetchAll(db, sql: "\(tagged) ORDER BY written_at DESC LIMIT ?", arguments: [tag.rawValue, limit])
            case .before(let tag, let before, let limit):
                try Row.fetchAll(
                    db, sql: "\(tagged) AND written_at < ? ORDER BY written_at DESC LIMIT ?",
                    arguments: [tag.rawValue, before.milliseconds, limit])
            }
        return try writtenEntries(rows)
    }
}

extension SQLiteRecords: StatsStore {
    /// スタッツはすべての記録を読むので、セッションごとに読まず表ごとにまとめて読む（`stats-sqlite.ts` と同じ）
    func findStatsRecords() throws -> StatsRecords {
        let changes = try advanceModeChanges()
        // 同じミリ秒の操作は記録した順（rowid）に並べる
        let eventRows = try Row.fetchAll(
            db, sql: "SELECT session_id, id, kind, at FROM session_events ORDER BY session_id, at, rowid")
        // 削除した記入も、自動終了の判断には書いたものとして数える
        let entryRows = try Row.fetchAll(
            db, sql: "SELECT \(journalEntryColumns) FROM journal_entries ORDER BY written_at")

        var timesBySession: [SessionId: [Instant]] = [:]
        var entries: [EntryMark] = []
        for row in entryRows {
            let stored = try storedJournalEntry(row)
            let reader = RowReader(row: row, table: "journal_entries")
            timesBySession[try reader.parsed("session_id", SessionId.init), default: []].append(
                try reader.instant("written_at"))
            switch stored {
            case .written(let entry):
                entries.append(
                    EntryMark(
                        sessionId: entry.sessionId, writtenAt: entry.writtenAt, writtenDuring: entry.writtenDuring,
                        tags: entry.tags))
            case .deleted: break
            }
        }

        var sessionOrder: [SessionId] = []
        var rowsBySession: [SessionId: [Row]] = [:]
        for row in eventRows {
            let id = try RowReader(row: row, table: "session_events").parsed("session_id", SessionId.init)
            if rowsBySession[id] == nil { sessionOrder.append(id) }
            rowsBySession[id, default: []].append(row)
        }
        let sessions = try sessionOrder.map { id in
            let events = try recordedEvents(rowsBySession[id] ?? [])
            return Session(
                id: id, events: events, journalEntryTimes: timesBySession[id] ?? [],
                // 閉じたあとの変更は計算に影響しないので、閉じた時刻で絞らなくてよい（ADR 0016）
                advanceModeChanges: AdvanceModeChange.relevantSince(changes, events.start.event.at))
        }
        return StatsRecords(sessions: sessions, entries: entries)
    }
}
