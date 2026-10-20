import * as v from "valibot";
import {
  JournalEntryBody,
  JournalEntryId,
  type DeleteJournalEntry,
  type FindJournalEntry,
  type JournalEntry,
  type ListJournalEntriesTaggedWith,
  type ListTagsOfOtherEntries,
  type SaveEditedJournalEntry,
  type SaveJournalEntry,
  type SaveJournalEntryTags,
  type StoredJournalEntry,
  type WrittenDuring,
} from "../domain/journal-entry.ts";
import type {
  FindEntryTimesWrittenIn,
  FindJournalEntriesWrittenIn,
} from "../domain/journal-calendar.ts";
import { SessionId } from "../domain/session.ts";
import { TagName, Tags, type ListTagsInUse, type ListTagUsage } from "../domain/tag.ts";
import type { FindJournalEntriesWithTag } from "../domain/tagged-entries.ts";
import type { FindTimelineSessions, TimelineSession } from "../domain/timeline.ts";
import { epochMs, parseRow, sessionLoader } from "./session-sqlite.ts";

// ---------------------------------------------------------------------------
// DB の行（境界）。読み出した行はスキーマで検証し、その場でドメインの型に変換する
// ---------------------------------------------------------------------------

const positiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * 記入の列。タグは別の表にあるので、つけた順に並べた JSON の配列にして1行に含める
 * （`journal_entries` を FROM に置いた SELECT で使う）
 */
const JOURNAL_ENTRY_COLUMNS = `id, session_id, body, written_at, updated_at, round, set_number, phase, deleted_at,
  (SELECT json_group_array(name) FROM
     (SELECT name FROM journal_entry_tags WHERE entry_id = journal_entries.id ORDER BY position)
  ) AS tags`;

/**
 * 紐付きの列（`round` / `set_number` / `phase`）を、書いた時点のタイマーの状態の型に戻す。
 * 休憩中はセット番号がなく、待機中はフェーズがない。それ以外の組み合わせは記録が壊れている。
 */
export const writtenDuringOf = (
  round: number,
  setNumber: number | null,
  phase: "Focus" | "Journal" | "Break" | null,
): WrittenDuring | undefined => {
  if (phase === "Break") {
    return setNumber === null ? { kind: "Break", round } : undefined;
  }
  if (setNumber === null) {
    return undefined;
  }
  return phase === null ? { kind: "Idle", round, setNumber } : { kind: phase, round, setNumber };
};

const JournalEntryRowSchema = v.pipe(
  v.object({
    id: JournalEntryId.schema,
    session_id: SessionId.schema,
    body: JournalEntryBody.schema,
    tags: v.pipe(v.string(), v.parseJson(), Tags.schema),
    written_at: epochMs,
    updated_at: epochMs,
    round: positiveInt,
    set_number: v.nullable(positiveInt),
    phase: v.nullable(v.picklist(["Focus", "Journal", "Break"])),
    deleted_at: v.nullable(epochMs),
  }),
  v.rawTransform(({ dataset, addIssue, NEVER }): StoredJournalEntry => {
    const row = dataset.value;
    if (row.deleted_at !== null) {
      return { kind: "Deleted", deleted: { id: row.id, deletedAt: new Date(row.deleted_at) } };
    }
    const writtenDuring = writtenDuringOf(row.round, row.set_number, row.phase);
    if (writtenDuring === undefined) {
      addIssue({ message: "紐付きの列の組み合わせが不正", path: undefined });
      return NEVER;
    }
    return {
      kind: "Written",
      entry: {
        id: row.id,
        sessionId: row.session_id,
        body: row.body,
        tags: row.tags,
        writtenAt: new Date(row.written_at),
        updatedAt: new Date(row.updated_at),
        writtenDuring,
      },
    };
  }),
);

const parseJournalEntryRow = parseRow(JournalEntryRowSchema, "journal_entries");

const SessionIdRowsSchema = v.array(v.object({ id: SessionId.schema }));
const parseSessionIdRows = parseRow(SessionIdRowsSchema, "sessions");

const WrittenAtRowsSchema = v.pipe(
  v.array(v.object({ written_at: epochMs })),
  v.transform((rows) => rows.map(({ written_at }) => new Date(written_at))),
);
const parseWrittenAtRows = parseRow(WrittenAtRowsSchema, "journal_entries");

const TagNameRowsSchema = v.pipe(
  v.array(v.object({ name: TagName.schema })),
  v.transform((rows) => rows.map(({ name }) => name)),
);
const parseTagNameRows = parseRow(TagNameRowsSchema, "journal_entry_tags");

const TagUsageRowsSchema = v.pipe(
  v.array(
    v.object({
      name: TagName.schema,
      entry_count: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  ),
  v.transform((rows) => rows.map(({ name, entry_count }) => ({ name, entryCount: entry_count }))),
);
const parseTagUsageRows = parseRow(TagUsageRowsSchema, "journal_entry_tags");

/** 紐付きを列に書く形にする */
const columnsOf = (writtenDuring: WrittenDuring) => {
  switch (writtenDuring.kind) {
    case "Focus":
    case "Journal":
      return { setNumber: writtenDuring.setNumber, phase: writtenDuring.kind };
    case "Break":
      return { setNumber: null, phase: writtenDuring.kind };
    case "Idle":
      return { setNumber: writtenDuring.setNumber, phase: null };
  }
};

// ---------------------------------------------------------------------------
// 読み書きの契約（domain/journal-entry.ts, domain/timeline.ts）を DO の SQLite で実装する
// ---------------------------------------------------------------------------

export type JournalSqlite = Readonly<{
  findJournalEntry: FindJournalEntry;
  listTagsOfOtherEntries: ListTagsOfOtherEntries;
  listTagsInUse: ListTagsInUse;
  listTagUsage: ListTagUsage;
  listJournalEntriesTaggedWith: ListJournalEntriesTaggedWith;
  saveJournalEntry: SaveJournalEntry;
  saveEditedJournalEntry: SaveEditedJournalEntry;
  saveJournalEntryTags: SaveJournalEntryTags;
  deleteJournalEntry: DeleteJournalEntry;
  findTimelineSessions: FindTimelineSessions;
  findEntryTimesWrittenIn: FindEntryTimesWrittenIn;
  findJournalEntriesWrittenIn: FindJournalEntriesWrittenIn;
  findJournalEntriesWithTag: FindJournalEntriesWithTag;
}>;

export const journalSqlite = (sql: SqlStorage): JournalSqlite => {
  const loadSession = sessionLoader(sql);

  /** 記入の行を記入にする。削除した記入は除く */
  const writtenEntriesFrom = (
    rows: ReadonlyArray<Record<string, SqlStorageValue>>,
  ): ReadonlyArray<JournalEntry> =>
    rows
      .map(parseJournalEntryRow)
      .flatMap((stored) => (stored.kind === "Written" ? [stored.entry] : []));

  /** セッションの削除していない記入 */
  const writtenEntriesOf = (sessionId: SessionId): ReadonlyArray<JournalEntry> =>
    writtenEntriesFrom(
      sql
        .exec(
          `SELECT ${JOURNAL_ENTRY_COLUMNS} FROM journal_entries
           WHERE session_id = ? AND deleted_at IS NULL ORDER BY written_at`,
          sessionId,
        )
        .toArray(),
    );

  /** 記入のタグを、つけた順に書き直す */
  const saveTags = (entry: JournalEntry): void => {
    sql.exec("DELETE FROM journal_entry_tags WHERE entry_id = ?", entry.id);
    entry.tags.forEach((name, position) => {
      sql.exec(
        "INSERT INTO journal_entry_tags (entry_id, position, name) VALUES (?, ?, ?)",
        entry.id,
        position,
        name,
      );
    });
  };

  return {
    findJournalEntry: (id) => {
      const [row] = sql
        .exec(`SELECT ${JOURNAL_ENTRY_COLUMNS} FROM journal_entries WHERE id = ?`, id)
        .toArray();
      return row === undefined ? undefined : parseJournalEntryRow(row);
    },

    saveJournalEntry: (entry) => {
      const { setNumber, phase } = columnsOf(entry.writtenDuring);
      sql.exec(
        `INSERT INTO journal_entries
           (id, session_id, body, written_at, round, set_number, phase, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.id,
        entry.sessionId,
        entry.body.unwrap(),
        entry.writtenAt.getTime(),
        entry.writtenDuring.round,
        setNumber,
        phase,
        entry.updatedAt.getTime(),
      );
      saveTags(entry);
    },

    saveEditedJournalEntry: (entry) => {
      sql.exec(
        "UPDATE journal_entries SET body = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        entry.body.unwrap(),
        entry.updatedAt.getTime(),
        entry.id,
      );
      saveTags(entry);
    },

    listTagsOfOtherEntries: (id) =>
      parseTagNameRows(
        sql
          .exec(
            `SELECT DISTINCT t.name FROM journal_entry_tags t
             JOIN journal_entries e ON e.id = t.entry_id
             WHERE e.deleted_at IS NULL AND e.id != ?`,
            id,
          )
          .toArray(),
      ),

    listTagsInUse: () =>
      parseTagNameRows(
        sql
          .exec(
            `SELECT t.name FROM journal_entry_tags t
             JOIN journal_entries e ON e.id = t.entry_id
             WHERE e.deleted_at IS NULL
             GROUP BY t.name ORDER BY MAX(e.written_at) DESC, t.name`,
          )
          .toArray(),
      ),

    // 1件の記入に同じタグは1つしかつかない（`Tags`）ので、行の数がそのまま記入の数になる
    listTagUsage: () =>
      parseTagUsageRows(
        sql
          .exec(
            `SELECT t.name, COUNT(*) AS entry_count FROM journal_entry_tags t
             JOIN journal_entries e ON e.id = t.entry_id
             WHERE e.deleted_at IS NULL
             GROUP BY t.name ORDER BY MAX(e.written_at) DESC, t.name`,
          )
          .toArray(),
      ),

    listJournalEntriesTaggedWith: (name) =>
      sql
        .exec(
          `SELECT ${JOURNAL_ENTRY_COLUMNS} FROM journal_entries
           WHERE deleted_at IS NULL
             AND id IN (SELECT entry_id FROM journal_entry_tags WHERE name = ?)`,
          name,
        )
        .toArray()
        .map(parseJournalEntryRow)
        .flatMap((stored) => (stored.kind === "Written" ? [stored.entry] : [])),

    saveJournalEntryTags: saveTags,

    deleteJournalEntry: (deleted) => {
      sql.exec(
        "UPDATE journal_entries SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        deleted.deletedAt.getTime(),
        deleted.id,
      );
    },

    findTimelineSessions: (range) => {
      const rows =
        range.kind === "Latest"
          ? sql.exec("SELECT id FROM sessions ORDER BY started_at DESC LIMIT ?", range.limit)
          : sql.exec(
              "SELECT id FROM sessions WHERE started_at < ? ORDER BY started_at DESC LIMIT ?",
              range.before.getTime(),
              range.limit,
            );
      return parseSessionIdRows(rows.toArray()).map(({ id }): TimelineSession => ({
        session: loadSession(id),
        entries: writtenEntriesOf(id),
      }));
    },

    findEntryTimesWrittenIn: (window) =>
      parseWrittenAtRows(
        sql
          .exec(
            `SELECT written_at FROM journal_entries
             WHERE deleted_at IS NULL AND written_at >= ? AND written_at < ?`,
            window.from.getTime(),
            window.until.getTime(),
          )
          .toArray(),
      ),

    findJournalEntriesWrittenIn: (window) =>
      writtenEntriesFrom(
        sql
          .exec(
            `SELECT ${JOURNAL_ENTRY_COLUMNS} FROM journal_entries
             WHERE deleted_at IS NULL AND written_at >= ? AND written_at < ? ORDER BY written_at`,
            window.from.getTime(),
            window.until.getTime(),
          )
          .toArray(),
      ),

    findJournalEntriesWithTag: (range) => {
      const tagged = `SELECT ${JOURNAL_ENTRY_COLUMNS} FROM journal_entries
        WHERE deleted_at IS NULL
          AND id IN (SELECT entry_id FROM journal_entry_tags WHERE name = ?)`;
      const rows =
        range.kind === "Latest"
          ? sql.exec(`${tagged} ORDER BY written_at DESC LIMIT ?`, range.tag, range.limit)
          : sql.exec(
              `${tagged} AND written_at < ? ORDER BY written_at DESC LIMIT ?`,
              range.tag,
              range.before.getTime(),
              range.limit,
            );
      return writtenEntriesFrom(rows.toArray());
    },
  };
};
