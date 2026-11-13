import * as v from "valibot";
import {
  Import,
  type FindOverlappingSession,
  type LoadAccountRecords,
  type SaveImportedAdvanceModeChange,
  type SaveImportedSession,
  type SessionExists,
  type SessionSpan,
} from "../domain/import.ts";
import { SessionId } from "../domain/session.ts";
import type { JournalSqlite } from "./journal-sqlite.ts";
import { epochMs, parseRow } from "./session-sqlite.ts";

const SessionSpanRowsSchema = v.array(
  v.pipe(
    v.object({ id: SessionId.schema, started_at: epochMs, ended_at: v.nullable(epochMs) }),
    v.transform((row): Readonly<{ id: SessionId; span: SessionSpan }> => ({
      id: row.id,
      span:
        row.ended_at === null
          ? { kind: "Open", startedAt: new Date(row.started_at) }
          : {
              kind: "Closed",
              startedAt: new Date(row.started_at),
              endedAt: new Date(row.ended_at),
            },
    })),
  ),
);
const parseSessionSpanRows = parseRow(SessionSpanRowsSchema, "sessions");

const OwnRecordsRowSchema = v.object({ own: v.picklist([0, 1]) });
const parseOwnRecordsRow = parseRow(OwnRecordsRowSchema, "sessions");

export type ImportSqlite = Readonly<{
  sessionExists: SessionExists;
  findOverlappingSession: FindOverlappingSession;
  loadAccountRecords: LoadAccountRecords;
  saveImportedSession: SaveImportedSession;
  saveImportedAdvanceModeChange: SaveImportedAdvanceModeChange;
}>;

/** 取り込み（ADR 0020）の読み書きの契約（domain/import.ts）を DO の SQLite で実装する */
export const importSqlite = (sql: SqlStorage, journal: JournalSqlite): ImportSqlite => ({
  sessionExists: (id) => sql.exec("SELECT 1 FROM sessions WHERE id = ?", id).toArray().length > 0,

  // アカウントのセッションは互いに重ならないので、`span` の終わりまでに始めたうちで最後に始めたものと
  // 重ならなければ、それより前のどれとも重ならない。同じ時刻に始めたものは後に記録したほうを見る
  findOverlappingSession: (span) => {
    const [latest] = parseSessionSpanRows(
      sql
        .exec(
          `SELECT id, started_at, ended_at FROM sessions
           WHERE started_at <= ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
          span.endedAt.getTime(),
        )
        .toArray(),
    );
    return latest !== undefined && Import.overlaps(span, latest.span) ? latest.id : undefined;
  },

  loadAccountRecords: () =>
    parseOwnRecordsRow(
      sql
        .exec(
          `SELECT (EXISTS (SELECT 1 FROM sessions WHERE origin = 'Account')
                   OR EXISTS (SELECT 1 FROM advance_mode_changes WHERE origin = 'Account')) AS own`,
        )
        .one(),
    ).own === 1
      ? { kind: "HasOwnRecords" }
      : { kind: "OnlyImported" },

  saveImportedSession: (session) => {
    sql.exec(
      "INSERT INTO sessions (id, started_at, ended_at, ended_by, origin) VALUES (?, ?, ?, ?, 'Import')",
      session.id,
      session.events[0].at.getTime(),
      session.endedAt.getTime(),
      session.endedBy,
    );
    // 配列の順に足すので、同じミリ秒の操作は rowid で記録した順に並ぶ
    for (const event of session.events) {
      sql.exec(
        "INSERT INTO session_events (id, session_id, kind, at) VALUES (?, ?, ?, ?)",
        event.id,
        session.id,
        event.kind,
        event.at.getTime(),
      );
    }
    for (const stored of session.entries) {
      switch (stored.kind) {
        case "Written":
          // タグの上限は確かめずに書く（ADR 0020）
          journal.saveJournalEntry(stored.entry);
          break;
        case "Deleted":
          // 端末は削除した記入の本文と紐付きを捨てている（ADR 0010）。列は NOT NULL なので埋め草を入れる。
          // 削除した記入の行は ID・書いた時刻・削除した時刻しか読まない（journal-sqlite.ts、stats-sqlite.ts）
          sql.exec(
            `INSERT INTO journal_entries
               (id, session_id, body, written_at, round, set_number, phase, updated_at, deleted_at)
             VALUES (?, ?, '', ?, 1, 1, NULL, ?, ?)`,
            stored.deleted.id,
            stored.sessionId,
            stored.writtenAt.getTime(),
            stored.writtenAt.getTime(),
            stored.deleted.deletedAt.getTime(),
          );
          break;
      }
    }
  },

  saveImportedAdvanceModeChange: ({ at, mode }) => {
    sql.exec(
      `INSERT INTO advance_mode_changes
         (changed_at, focus_to_journal, journal_to_focus, journal_to_break, break_to_focus, origin)
       VALUES (?, ?, ?, ?, ?, 'Import')`,
      at.getTime(),
      mode.FocusToJournal,
      mode.JournalToFocus,
      mode.JournalToBreak,
      mode.BreakToFocus,
    );
  },
});
