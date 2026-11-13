import * as v from "valibot";
import {
  DeletedJournalEntryJsonSchema,
  JournalEntry,
  JournalEntryJsonSchema,
  type DeletedJournalEntry,
  type JournalEntryJson,
} from "./journal-entry.ts";
import { JsonDateSchema } from "./json-date.ts";
import { RecordedSessionEventsJsonSchema, type RecordedSessionEvents } from "./session-event.ts";
import { SessionId } from "./session.ts";
import type { Ended } from "./timer-state.ts";

/**
 * セッションの記録の JSON の形式の版。この端末の記録先（ADR 0019）が IndexedDB に置く値と、
 * 取り込み（ADR 0020）の束の要素の両方がこの形式なので、サーバーとこの端末の両方から使う
 */
export const SESSION_RECORD_FORMAT_VERSION = 1;

/**
 * 記録されている記入。削除した記入は本文とタグを捨て、ID・削除した時刻・セッション・書いた時刻だけを残す。
 * ID は同じ記入の再送を見分けるため、書いた時刻は自動終了の判断で削除した記入も数えるため（ADR 0010）。
 */
export type StoredEntry =
  | Readonly<{ kind: "Written"; entry: JournalEntry }>
  | Readonly<{
      kind: "Deleted";
      deleted: DeletedJournalEntry;
      sessionId: SessionId;
      writtenAt: Date;
    }>;

/** `events` は SQLite の `ORDER BY at, rowid` の順に並べておく。同じミリ秒の操作は記録した順になる */
export type StoredSession = Readonly<{
  id: SessionId;
  events: RecordedSessionEvents;
  entries: ReadonlyArray<StoredEntry>;
}>;

/** 閉じたセッション。`sessions.ended_at` / `ended_by` と同じものだけを持ち、終了の状態はドメインで計算し直す */
export type ClosedSession = StoredSession & Readonly<{ endedAt: Date; endedBy: Ended["endedBy"] }>;

/** 1つのセッションの記録。この端末の記録先にはセッションごとに1件ずつ置く（ADR 0019） */
export type SessionRecord =
  | Readonly<{ kind: "Open"; session: StoredSession }>
  | Readonly<{ kind: "Closed"; session: ClosedSession }>;

type StoredEntryJson =
  | Readonly<{ kind: "Written"; entry: JournalEntryJson }>
  | Extract<StoredEntry, { kind: "Deleted" }>;

type ClosingJson =
  | Readonly<{ kind: "Open" }>
  | Readonly<{ kind: "Closed"; endedAt: Date; endedBy: Ended["endedBy"] }>;

/**
 * JSON にできるセッションの記録。本文は取り出してある（`Sensitive` は JSON にすると伏せ字になる）。
 * 時刻は `Date` のままでよい（`JSON.stringify` が ISO 8601 の文字列にする）
 */
export type SessionRecordJson = Readonly<{
  version: number;
  id: SessionId;
  events: RecordedSessionEvents;
  closing: ClosingJson;
  entries: ReadonlyArray<StoredEntryJson>;
}>;

const StoredEntryJsonSchema = v.variant("kind", [
  v.object({ kind: v.literal("Written"), entry: JournalEntryJsonSchema }),
  v.object({
    kind: v.literal("Deleted"),
    deleted: DeletedJournalEntryJsonSchema,
    sessionId: SessionId.schema,
    writtenAt: JsonDateSchema,
  }),
]);

const ClosingJsonSchema = v.variant("kind", [
  v.object({ kind: v.literal("Open") }),
  v.object({
    kind: v.literal("Closed"),
    endedAt: JsonDateSchema,
    endedBy: v.picklist(["End", "AutoEnd"]),
  }),
]);

const sessionIdOf = (stored: StoredEntry): SessionId => {
  switch (stored.kind) {
    case "Written":
      return stored.entry.sessionId;
    case "Deleted":
      return stored.sessionId;
  }
};

/**
 * JSON にしたセッションの記録を検証して戻す。版はこの版だけを受け付ける。
 * 新しい版を区別して扱いたい呼び出し側（この端末の記録先）は、先に版を確かめる
 */
export const SessionRecordJsonSchema: v.GenericSchema<unknown, SessionRecord> = v.pipe(
  v.object({
    version: v.literal(SESSION_RECORD_FORMAT_VERSION),
    id: SessionId.schema,
    events: RecordedSessionEventsJsonSchema,
    closing: ClosingJsonSchema,
    entries: v.array(StoredEntryJsonSchema),
  }),
  v.check(
    ({ id, entries }) => entries.every((stored) => sessionIdOf(stored) === id),
    "記入のセッションが、記入を持つセッションと違う",
  ),
  v.transform(({ id, events, closing, entries }): SessionRecord => {
    switch (closing.kind) {
      case "Open":
        return { kind: "Open", session: { id, events, entries } };
      case "Closed":
        return {
          kind: "Closed",
          session: { id, events, entries, endedAt: closing.endedAt, endedBy: closing.endedBy },
        };
    }
  }),
);

const closingOf = (record: SessionRecord): ClosingJson => {
  switch (record.kind) {
    case "Open":
      return { kind: "Open" };
    case "Closed":
      return {
        kind: "Closed",
        endedAt: record.session.endedAt,
        endedBy: record.session.endedBy,
      };
  }
};

export const SessionRecord = {
  /** JSON にできる形。本文はここでだけ取り出す */
  toJson: (record: SessionRecord): SessionRecordJson => ({
    version: SESSION_RECORD_FORMAT_VERSION,
    id: record.session.id,
    events: record.session.events,
    closing: closingOf(record),
    entries: record.session.entries.map((stored): StoredEntryJson => {
      switch (stored.kind) {
        case "Written":
          return { kind: stored.kind, entry: JournalEntry.toJson(stored.entry) };
        case "Deleted":
          return stored;
      }
    }),
  }),
} as const;

/**
 * 閉じたセッションの記録だけを受け取る（取り込み、ADR 0020）。開いているセッションと、
 * 終わった時刻が始めた時刻より前のセッションは検証に失敗する
 */
export const ClosedSessionRecordJsonSchema: v.GenericSchema<unknown, ClosedSession> = v.pipe(
  SessionRecordJsonSchema,
  v.rawTransform(({ dataset, addIssue, NEVER }): ClosedSession => {
    const record = dataset.value;
    switch (record.kind) {
      case "Open":
        addIssue({ message: "閉じていないセッションは取り込めない", path: undefined });
        return NEVER;
      case "Closed":
        return record.session;
    }
  }),
  v.check(
    (session) => session.endedAt.getTime() >= session.events[0].at.getTime(),
    "終わった時刻が始めた時刻より前",
  ),
);
