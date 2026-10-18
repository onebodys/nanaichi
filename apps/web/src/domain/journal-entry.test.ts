import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import {
  JournalEntry,
  JournalEntryBody,
  JournalEntryId,
  JournalEntryJsonSchema,
} from "./journal-entry.ts";
import { schemaResult } from "./schema-result.ts";
import { SessionEventId } from "./session-event.ts";
import { Session, SessionId } from "./session.ts";
import { TagName } from "./tag.ts";

const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
const at = (minutes: number, seconds = 0) =>
  new Date(STARTED_AT + minutes * 60_000 + seconds * 1000);

const sessionId = v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000000");
const entryId = v.parse(JournalEntryId.schema, "00000000-0000-4000-8000-0000000000e1");
const eventId = (n: number) =>
  v.parse(SessionEventId.schema, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const body = (text: string) => v.parse(JournalEntryBody.schema, text);

const started = Session.start(sessionId, eventId(0), at(0));

/** 開始から `now` までの操作を加えたセッションで、時刻 `now` に書く */
const writeAt = (now: Date, session: Session = started) =>
  JournalEntry.write({
    id: entryId,
    body: body("メモ"),
    tags: [],
    sessionId: session.id,
    state: Session.stateAt(session, now),
    now,
  });

const writtenDuringAt = (now: Date, session?: Session) => {
  const written = writeAt(now, session);
  return Result.isSuccess(written) ? written.value.writtenDuring : written.error;
};

describe("ジャーナル記入の紐付き", () => {
  test("集中中に書くと、ラウンド・セット・集中に紐付く", () => {
    expect(writtenDuringAt(at(3))).toEqual({ kind: "Focus", round: 1, setNumber: 1 });
  });

  test("ジャーナル中に書くと、そのセットのジャーナルに紐付く", () => {
    expect(writtenDuringAt(at(15, 30))).toEqual({ kind: "Journal", round: 1, setNumber: 2 });
  });

  test("休憩中に書くと、ラウンドと休憩に紐付き、セットには紐付かない", () => {
    expect(writtenDuringAt(at(26))).toEqual({ kind: "Break", round: 1 });
  });

  test("待機中に書くと、フェーズには紐付かず、次にやり直すセットに紐付く", () => {
    const aborted: Session = {
      ...started,
      events: [...started.events, { kind: "Abort", id: eventId(1), at: at(10) }],
    };

    expect(writtenDuringAt(at(11), aborted)).toEqual({ kind: "Idle", round: 1, setNumber: 2 });
  });

  test("終了したセッションには書けない", () => {
    const ended: Session = {
      ...started,
      events: [...started.events, { kind: "End", id: eventId(1), at: at(5) }],
    };

    expect(writtenDuringAt(at(6), ended)).toEqual({ kind: "NoSessionInProgress" });
  });

  test("自動終了の時刻を過ぎたセッションには書けない", () => {
    expect(writtenDuringAt(at(58))).toEqual({ kind: "NoSessionInProgress" });
  });

  test("書いた時刻と更新時刻は、書いた時刻になる", () => {
    const written = writeAt(at(3));

    expect(Result.isSuccess(written) && written.value).toMatchObject({
      writtenAt: at(3),
      updatedAt: at(3),
    });
  });
});

describe("ジャーナル記入の編集", () => {
  test("本文・タグと更新時刻だけが変わり、書いた時刻と紐付きは変わらない", () => {
    const written = writeAt(at(3));
    if (Result.isFailure(written)) throw new Error("書けなかった");

    const edited = JournalEntry.edit(
      written.value,
      { body: body("直した"), tags: [v.parse(TagName.schema, "読書")] },
      at(30),
    );

    expect(edited.body.unwrap()).toBe("直した");
    expect(edited).toMatchObject({
      tags: ["読書"],
      writtenAt: at(3),
      updatedAt: at(30),
      writtenDuring: { kind: "Focus", round: 1, setNumber: 1 },
    });
  });
});

describe("本文", () => {
  test("前後の空白を落とし、改行は残す", () => {
    expect(body("  1行目\n2行目\n ").unwrap()).toBe("1行目\n2行目");
  });

  test.each([[""], ["  \n  "]])("空の本文 %j は書けない", (text) => {
    expect(v.safeParse(JournalEntryBody.schema, text).success).toBe(false);
  });

  test("本文は PII なので、JSON にすると伏せられる", () => {
    expect(JSON.stringify({ body: body("秘密のメモ") })).toBe('{"body":"[REDACTED]"}');
  });

  test("応答の JSON では本文を取り出し、スキーマで検証すると Sensitive に包み直す", () => {
    const written = writeAt(at(3));
    if (Result.isFailure(written)) throw new Error("書けなかった");

    const overTheWire: unknown = JSON.parse(JSON.stringify(JournalEntry.toJson(written.value)));
    const parsed = schemaResult(JournalEntryJsonSchema)(overTheWire);

    expect(overTheWire).toMatchObject({ body: "メモ" });
    expect(Result.isSuccess(parsed) && parsed.value.body.unwrap()).toBe("メモ");
    expect(Result.isSuccess(parsed) && parsed.value.writtenAt).toEqual(at(3));
  });
});
