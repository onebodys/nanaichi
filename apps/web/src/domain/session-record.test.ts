import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { JournalEntryId } from "./journal-entry.ts";
import { schemaResult } from "./schema-result.ts";
import { Sensitive } from "./sensitive.ts";
import { SessionEventId } from "./session-event.ts";
import { SessionRecord, SessionRecordJsonSchema, type ClosedSession } from "./session-record.ts";
import { SessionId } from "./session.ts";
import { TagName } from "./tag.ts";

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = v.parse(SessionId.schema, uuid(1));
const otherSessionId = v.parse(SessionId.schema, uuid(2));

const closed: ClosedSession = {
  id: sessionId,
  events: [
    { kind: "Start", id: v.parse(SessionEventId.schema, uuid(10)), at: at(0) },
    { kind: "End", id: v.parse(SessionEventId.schema, uuid(11)), at: at(30) },
  ],
  entries: [
    {
      kind: "Written",
      entry: {
        id: v.parse(JournalEntryId.schema, uuid(20)),
        sessionId,
        body: Sensitive.of("読書をした"),
        tags: [v.parse(TagName.schema, "読書")],
        writtenAt: at(10),
        updatedAt: at(12),
        writtenDuring: { kind: "Journal", round: 1, setNumber: 1 },
      },
    },
    {
      kind: "Deleted",
      deleted: { id: v.parse(JournalEntryId.schema, uuid(21)), deletedAt: at(20) },
      sessionId,
      writtenAt: at(15),
    },
  ],
  endedAt: at(30),
  endedBy: "End",
};

const parse = schemaResult(SessionRecordJsonSchema);
const overTheWire = (record: SessionRecord): unknown =>
  JSON.parse(JSON.stringify(SessionRecord.toJson(record)));

/** 本文の `Sensitive` は関数を持つので `toEqual` では比べられない。本文を取り出した形で比べる */
const roundTrip = (record: SessionRecord) => {
  const decoded = parse(overTheWire(record));
  return Result.isSuccess(decoded) ? SessionRecord.toJson(decoded.value) : decoded;
};

describe("セッションの記録の JSON", () => {
  test("閉じたセッションの記録を JSON にして戻すと、同じセッションになる", () => {
    const record: SessionRecord = { kind: "Closed", session: closed };

    expect(roundTrip(record)).toEqual(SessionRecord.toJson(record));
  });

  test("開いているセッションの記録を JSON にして戻すと、開いたままになる", () => {
    const { endedAt: _endedAt, endedBy: _endedBy, ...open } = closed;
    const record: SessionRecord = { kind: "Open", session: open };

    expect(roundTrip(record)).toEqual(SessionRecord.toJson(record));
  });

  test("記入の本文は JSON にしても伏せ字にならず、戻すと Sensitive に包まれる", () => {
    const json = JSON.stringify(SessionRecord.toJson({ kind: "Closed", session: closed }));
    expect(json).toContain("読書をした");
    expect(json).not.toContain("[REDACTED]");

    const decoded = parse(JSON.parse(json));
    const written = Result.isSuccess(decoded) ? decoded.value.session.entries[0] : undefined;
    const body = written?.kind === "Written" ? written.entry.body : undefined;
    expect(body?.unwrap()).toBe("読書をした");
    expect(JSON.stringify(body)).toBe('"[REDACTED]"');
  });

  test("記入のセッションが記録のセッションと違えば、検証に失敗する", () => {
    const json = SessionRecord.toJson({
      kind: "Closed",
      session: {
        ...closed,
        entries: [
          {
            kind: "Deleted",
            deleted: { id: v.parse(JournalEntryId.schema, uuid(22)), deletedAt: at(20) },
            sessionId: otherSessionId,
            writtenAt: at(15),
          },
        ],
      },
    });

    expect(parse(JSON.parse(JSON.stringify(json)))).toMatchObject({ type: "Failure" });
  });

  test("知らない版の記録は、検証に失敗する", () => {
    const json = { ...SessionRecord.toJson({ kind: "Closed", session: closed }), version: 2 };

    expect(parse(JSON.parse(JSON.stringify(json)))).toMatchObject({ type: "Failure" });
  });
});
