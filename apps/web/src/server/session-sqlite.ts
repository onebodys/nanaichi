import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { schemaResult } from "../domain/schema-result.ts";
import {
  SessionEventId,
  SessionOperationKind,
  type RecordedSessionEvent,
  type RecordedSessionEvents,
  type SessionOperation,
} from "../domain/session-event.ts";
import {
  SessionId,
  type Session,
  type AppendSessionOperation,
  type CloseSession,
  type FindOpenSession,
  type FindSessionByEventId,
  type SaveStartedSession,
} from "../domain/session.ts";
import { describeIssuePaths } from "./validation-error.ts";

// ---------------------------------------------------------------------------
// DB の行（境界）。読み出した行はスキーマで検証し、その場でドメインの型に変換する
// ---------------------------------------------------------------------------

const epochMs = v.pipe(v.number(), v.integer());

const StartRowSchema = v.pipe(
  v.object({ id: SessionEventId.schema, kind: v.literal("Start"), at: epochMs }),
  v.transform((row): RecordedSessionEvents[0] => ({
    kind: row.kind,
    id: row.id,
    at: new Date(row.at),
  })),
);

const OperationRowSchema = v.pipe(
  v.object({ id: SessionEventId.schema, kind: SessionOperationKind.schema, at: epochMs }),
  v.transform((row): RecordedSessionEvent<SessionOperation> => ({
    kind: row.kind,
    id: row.id,
    at: new Date(row.at),
  })),
);

/** セッションの操作イベントは必ず開始から始まる */
const EventRowsSchema = v.tupleWithRest([StartRowSchema], OperationRowSchema);

const JournalEntryTimeRowsSchema = v.array(
  v.pipe(
    v.object({ written_at: epochMs }),
    v.transform((row) => new Date(row.written_at)),
  ),
);

const SessionIdRowSchema = v.object({ id: SessionId.schema });

/**
 * 自分で書いた行が読めないのは、記録が壊れているか実装の誤り。想定内の失敗ではないので例外にする。
 * どの列がおかしいかだけを出し、値は出さない（ジャーナル記入の本文は PII）。
 */
const parseRow =
  <T>(schema: v.GenericSchema<unknown, T>, table: string) =>
  (raw: unknown): T => {
    const parsed = schemaResult(schema)(raw);
    if (Result.isFailure(parsed)) {
      throw new Error(`${table} の行を読めない: ${describeIssuePaths(parsed.error).join(", ")}`);
    }
    return parsed.value;
  };

const parseEventRows = parseRow(EventRowsSchema, "session_events");
const parseJournalEntryTimeRows = parseRow(JournalEntryTimeRowsSchema, "journal_entries");
const parseSessionIdRow = parseRow(SessionIdRowSchema, "sessions");

// ---------------------------------------------------------------------------
// 読み書きの契約（domain/session.ts）を DO の SQLite で実装する
// ---------------------------------------------------------------------------

export type SessionSqlite = Readonly<{
  findOpenSession: FindOpenSession;
  findSessionByEventId: FindSessionByEventId;
  saveStartedSession: SaveStartedSession;
  appendSessionOperation: AppendSessionOperation;
  closeSession: CloseSession;
}>;

export const sessionSqlite = (sql: SqlStorage): SessionSqlite => {
  const loadSession = (id: SessionId): Session => ({
    id,
    // 同じミリ秒の操作は記録した順（rowid）に並べる
    events: parseEventRows(
      sql
        .exec("SELECT id, kind, at FROM session_events WHERE session_id = ? ORDER BY at, rowid", id)
        .toArray(),
    ),
    // 削除した記入も、書いたことには変わりないので自動終了の判断に含める
    journalEntryTimes: parseJournalEntryTimeRows(
      sql
        .exec("SELECT written_at FROM journal_entries WHERE session_id = ? ORDER BY written_at", id)
        .toArray(),
    ),
  });

  const sessionIdOf = (rows: ReadonlyArray<unknown>): SessionId | undefined => {
    const [row] = rows;
    return row === undefined ? undefined : parseSessionIdRow(row).id;
  };

  const loadIfFound = (id: SessionId | undefined): Session | undefined =>
    id === undefined ? undefined : loadSession(id);

  return {
    findOpenSession: () =>
      loadIfFound(
        sessionIdOf(sql.exec("SELECT id FROM sessions WHERE ended_at IS NULL").toArray()),
      ),

    findSessionByEventId: (eventId) =>
      loadIfFound(
        sessionIdOf(
          sql.exec("SELECT session_id AS id FROM session_events WHERE id = ?", eventId).toArray(),
        ),
      ),

    saveStartedSession: (session) => {
      const [start] = session.events;
      sql.exec(
        "INSERT INTO sessions (id, started_at) VALUES (?, ?)",
        session.id,
        start.at.getTime(),
      );
      sql.exec(
        "INSERT INTO session_events (id, session_id, kind, at) VALUES (?, ?, ?, ?)",
        start.id,
        session.id,
        start.kind,
        start.at.getTime(),
      );
    },

    appendSessionOperation: (sessionId, operation) => {
      sql.exec(
        "INSERT INTO session_events (id, session_id, kind, at) VALUES (?, ?, ?, ?)",
        operation.id,
        sessionId,
        operation.kind,
        operation.at.getTime(),
      );
    },

    closeSession: (sessionId, ended) => {
      sql.exec(
        "UPDATE sessions SET ended_at = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL",
        ended.endedAt.getTime(),
        ended.endedBy,
        sessionId,
      );
    },
  };
};
