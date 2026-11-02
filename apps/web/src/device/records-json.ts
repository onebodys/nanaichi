import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { AdvanceModeChangeJsonSchema } from "../domain/advance-mode.ts";
import {
  DeletedJournalEntryJsonSchema,
  JournalEntry,
  JournalEntryJsonSchema,
} from "../domain/journal-entry.ts";
import { JsonDateSchema } from "../domain/json-date.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import { RecordedSessionEventsJsonSchema } from "../domain/session-event.ts";
import { SessionId } from "../domain/session.ts";
import type { ClosedSession, DeviceRecords, SessionRecord, StoredEntry } from "./records.ts";

/**
 * この端末の記録を保存する形（ADR 0019）。セッションごとに1件と、進め方の変更履歴の1件に分ける。
 *
 * 記入の本文は `Sensitive` に包まれていて、`JSON.stringify` すると `"[REDACTED]"` になって消える。
 * 書くときは `JournalEntry.toJson` で取り出し、読むときは `JournalEntryJsonSchema` で包み直す。
 * どの1件も `version` を持ち、知らない新しい版はこのアプリでは読まない（上書きもしない）。
 */
const FORMAT_VERSION = 1;

/** 保存した記録を読めない。値は返さず、どこがおかしいかだけを返す（記入の本文は PII） */
export type RecordsUnreadable =
  | Readonly<{ kind: "NewerFormat"; version: number }>
  | Readonly<{ kind: "Malformed"; paths: ReadonlyArray<string> }>;

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

const SessionRecordJsonSchema: v.GenericSchema<unknown, SessionRecord> = v.pipe(
  v.object({
    version: v.literal(FORMAT_VERSION),
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

const MetaRecordJsonSchema = v.object({
  version: v.literal(FORMAT_VERSION),
  advanceModeChanges: v.array(AdvanceModeChangeJsonSchema),
});

const VersionSchema = v.object({ version: v.pipe(v.number(), v.integer()) });

const describePath = (issue: ValidationError["issues"][number]): string =>
  issue.path === undefined || issue.path.length === 0
    ? "(root)"
    : issue.path
        .map((segment) =>
          typeof segment === "object" && segment !== null && "key" in segment
            ? String(segment.key)
            : String(segment),
        )
        .join(".");

const malformed = (error: ValidationError): RecordsUnreadable => ({
  kind: "Malformed",
  paths: error.issues.map(describePath),
});

const parseJson = (raw: string): Result.Result<unknown, RecordsUnreadable> => {
  try {
    return Result.succeed(JSON.parse(raw));
  } catch {
    return Result.fail({ kind: "Malformed", paths: ["(json)"] });
  }
};

/** 新しい版のアプリが書いたものは、どこが読めないかではなく版が新しいことを返す（上書きさせないため） */
const ensureKnownVersion = (json: unknown): Result.Result<unknown, RecordsUnreadable> =>
  Result.pipe(
    schemaResult(VersionSchema)(json),
    Result.mapError(malformed),
    Result.andThen(({ version }) =>
      version > FORMAT_VERSION
        ? Result.fail({ kind: "NewerFormat", version } satisfies RecordsUnreadable)
        : Result.succeed(json),
    ),
  );

const decodeWith =
  <T>(schema: v.GenericSchema<unknown, T>) =>
  (raw: string): Result.Result<T, RecordsUnreadable> =>
    Result.pipe(
      parseJson(raw),
      Result.andThen(ensureKnownVersion),
      Result.andThen((json) => Result.pipe(schemaResult(schema)(json), Result.mapError(malformed))),
    );

/** 開いているセッションは高々1つ。閉じたセッションは開始の順に並べる */
const assemble = (
  advanceModeChanges: DeviceRecords["advanceModeChanges"],
  records: ReadonlyArray<SessionRecord>,
): Result.Result<DeviceRecords, RecordsUnreadable> => {
  const open = records.flatMap((record) => (record.kind === "Open" ? [record.session] : []));
  const [only, ...more] = open;
  if (more.length > 0) {
    return Result.fail({ kind: "Malformed", paths: ["(open sessions)"] });
  }
  const closed = records
    .flatMap((record): ReadonlyArray<ClosedSession> =>
      record.kind === "Closed" ? [record.session] : [],
    )
    .toSorted((a, b) => a.events[0].at.getTime() - b.events[0].at.getTime());
  return Result.succeed({
    closed,
    open: only === undefined ? { kind: "NoOpenSession" } : { kind: "Open", session: only },
    advanceModeChanges,
  });
};

/** セッションの1件を保存する文字列にする */
export const encodeSessionRecord = (record: SessionRecord): string => {
  const { id, events, entries } = record.session;
  const closing = (() => {
    switch (record.kind) {
      case "Open":
        return { kind: "Open" } as const;
      case "Closed":
        return {
          kind: "Closed",
          endedAt: record.session.endedAt,
          endedBy: record.session.endedBy,
        } as const;
    }
  })();
  return JSON.stringify({
    version: FORMAT_VERSION,
    id,
    events,
    closing,
    entries: entries.map((stored) => {
      switch (stored.kind) {
        case "Written":
          return { kind: stored.kind, entry: JournalEntry.toJson(stored.entry) };
        case "Deleted":
          return stored;
      }
    }),
  });
};

/** セッション以外の記録（進め方の変更履歴）の1件を保存する文字列にする */
export const encodeMetaRecord = (records: DeviceRecords): string =>
  JSON.stringify({ version: FORMAT_VERSION, advanceModeChanges: records.advanceModeChanges });

/** 保存した1件ずつを検証して、この端末の記録に戻す。1件でも読めなければ全体を読めないとする */
export const decodeRecords = (
  meta: string,
  sessions: ReadonlyArray<string>,
): Result.Result<DeviceRecords, RecordsUnreadable> =>
  Result.pipe(
    Result.do(),
    Result.bind("meta", () => decodeWith(MetaRecordJsonSchema)(meta)),
    Result.bind("sessions", () => Result.sequence(sessions, decodeWith(SessionRecordJsonSchema))),
    Result.andThen(({ meta, sessions }) => assemble(meta.advanceModeChanges, sessions)),
  );
