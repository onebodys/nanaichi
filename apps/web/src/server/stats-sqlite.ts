import * as v from "valibot";
import { AdvanceModeChange } from "../domain/advance-mode.ts";
import { SessionId, type Session } from "../domain/session.ts";
import { SessionEventId, SessionOperationKind } from "../domain/session-event.ts";
import type { EntryMark, FindStatsRecords } from "../domain/stats.ts";
import { Tags } from "../domain/tag.ts";
import { writtenDuringOf } from "./journal-sqlite.ts";
import { advanceModeChangesOf, epochMs, parseRow } from "./session-sqlite.ts";

// ---------------------------------------------------------------------------
// DB の行（境界）。スタッツはすべての記録を読むので、セッションごとに読まず表ごとにまとめて読む
// ---------------------------------------------------------------------------

const positiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));

const EventRowsSchema = v.array(
  v.object({
    session_id: SessionId.schema,
    id: SessionEventId.schema,
    kind: v.union([v.literal("Start"), SessionOperationKind.schema]),
    at: epochMs,
  }),
);

const EntryRowsSchema = v.array(
  v.object({
    session_id: SessionId.schema,
    written_at: epochMs,
    round: positiveInt,
    set_number: v.nullable(positiveInt),
    phase: v.nullable(v.picklist(["Focus", "Journal", "Break"])),
    deleted_at: v.nullable(epochMs),
    tags: v.pipe(v.string(), v.parseJson(), Tags.schema),
  }),
);

const SessionRowsSchema = v.array(
  v.object({ id: SessionId.schema, ended_at: v.nullable(epochMs) }),
);

const parseEventRows = parseRow(EventRowsSchema, "session_events");
const parseSessionRows = parseRow(SessionRowsSchema, "sessions");
const parseEntryRows = parseRow(EntryRowsSchema, "journal_entries");

type EventRow = v.InferOutput<typeof EventRowsSchema>[number];

/** 1つのセッションの操作イベントの行（時刻の順）を、開始から始まる操作イベントにする */
const sessionOf = (
  id: SessionId,
  endedAt: number | null,
  rows: ReadonlyArray<EventRow>,
  journalEntryTimes: ReadonlyArray<Date>,
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>,
): Session => {
  const [start, ...rest] = rows;
  if (start === undefined || start.kind !== "Start") {
    throw new Error("session_events の行を読めない: セッションが開始から始まっていない");
  }
  return {
    id,
    events: [
      { kind: "Start", id: start.id, at: new Date(start.at) },
      ...rest.map((row) => {
        if (row.kind === "Start") {
          throw new Error("session_events の行を読めない: 開始が2つある");
        }
        return { kind: row.kind, id: row.id, at: new Date(row.at) };
      }),
    ],
    journalEntryTimes,
    // 閉じたセッションは閉じた時刻までの変更で計算する（sessionLoader と同じ）。自動終了したセッションの
    // 閉じた時刻は最後の記入・操作の時刻なので、そのあとに取り込みで足した行（ADR 0020）を操作として数えないため
    advanceModeChanges: AdvanceModeChange.relevantSince(
      advanceModeChanges,
      new Date(start.at),
    ).filter((change) => endedAt === null || change.at.getTime() <= endedAt),
  };
};

const groupBy = <T, K>(items: ReadonlyArray<T>, keyOf: (item: T) => K): Map<K, Array<T>> => {
  const groups = new Map<K, Array<T>>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
};

/** 読み書きの契約（domain/stats.ts）を DO の SQLite で実装する */
export const statsSqlite = (sql: SqlStorage): Readonly<{ findStatsRecords: FindStatsRecords }> => ({
  findStatsRecords: () => {
    // 同じミリ秒の操作は記録した順（rowid）に並べる（session-sqlite.ts と同じ）
    const events = parseEventRows(
      sql
        .exec("SELECT session_id, id, kind, at FROM session_events ORDER BY session_id, at, rowid")
        .toArray(),
    );
    // 削除した記入も、自動終了の判断には書いたものとして数える（session-sqlite.ts と同じ）
    const entryRows = parseEntryRows(
      sql
        .exec(
          `SELECT session_id, written_at, round, set_number, phase, deleted_at,
             (SELECT json_group_array(name) FROM
                (SELECT name FROM journal_entry_tags WHERE entry_id = journal_entries.id ORDER BY position)
             ) AS tags
           FROM journal_entries ORDER BY written_at`,
        )
        .toArray(),
    );
    const entriesBySession = groupBy(entryRows, (row) => row.session_id);
    const advanceModeChanges = advanceModeChangesOf(sql);
    const endedAtById = new Map(
      parseSessionRows(sql.exec("SELECT id, ended_at FROM sessions").toArray()).map(
        ({ id, ended_at }) => [id, ended_at],
      ),
    );

    const sessions = [...groupBy(events, (row) => row.session_id)].map(([id, rows]) =>
      sessionOf(
        id,
        endedAtById.get(id) ?? null,
        rows,
        (entriesBySession.get(id) ?? []).map((row) => new Date(row.written_at)),
        advanceModeChanges,
      ),
    );
    const entries = entryRows
      .filter((row) => row.deleted_at === null)
      .map((row): EntryMark => {
        const writtenDuring = writtenDuringOf(row.round, row.set_number, row.phase);
        if (writtenDuring === undefined) {
          throw new Error("journal_entries の行を読めない: 紐付きの列の組み合わせが不正");
        }
        return {
          sessionId: row.session_id,
          writtenAt: new Date(row.written_at),
          writtenDuring,
          tags: row.tags,
        };
      });
    return { sessions, entries };
  },
});
