import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { AdvanceModeChangeJsonSchema } from "../domain/advance-mode.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import {
  SESSION_RECORD_FORMAT_VERSION,
  SessionRecord,
  SessionRecordJsonSchema,
  type ClosedSession,
} from "../domain/session-record.ts";
import type { DeviceRecords } from "./records.ts";

/** 保存した記録を読めない。値は返さず、どこがおかしいかだけを返す（記入の本文は PII） */
export type RecordsUnreadable =
  | Readonly<{ kind: "NewerFormat"; version: number }>
  | Readonly<{ kind: "Malformed"; paths: ReadonlyArray<string> }>;

const MetaRecordJsonSchema = v.object({
  version: v.literal(SESSION_RECORD_FORMAT_VERSION),
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
      version > SESSION_RECORD_FORMAT_VERSION
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

/** 読み込んだセッションの記録と進め方の履歴を、この端末の記録にまとめる。開いているセッションは多くて1つ */
export const assembleRecords = (
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

export const encodeSessionRecord = (record: SessionRecord): string =>
  JSON.stringify(SessionRecord.toJson(record));

export const encodeMetaRecord = (records: DeviceRecords): string =>
  JSON.stringify({
    version: SESSION_RECORD_FORMAT_VERSION,
    advanceModeChanges: records.advanceModeChanges,
  });

export const decodeSessionRecord = decodeWith(SessionRecordJsonSchema);

export const decodeMetaRecord = decodeWith(MetaRecordJsonSchema);

/** 保存した1件ずつを検証して、この端末の記録に戻す。1件でも読めなければ全体を読めないとする */
export const decodeRecords = (
  meta: string,
  sessions: ReadonlyArray<string>,
): Result.Result<DeviceRecords, RecordsUnreadable> =>
  Result.pipe(
    Result.do(),
    Result.bind("meta", () => decodeMetaRecord(meta)),
    Result.bind("sessions", () => Result.sequence(sessions, decodeSessionRecord)),
    Result.andThen(({ meta, sessions }) => assembleRecords(meta.advanceModeChanges, sessions)),
  );
