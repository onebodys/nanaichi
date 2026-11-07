import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { goldenCases, settled } from "../testing/golden.ts";
import { parsedBy, uuid, type Parsed } from "../testing/golden-values.ts";
import {
  JournalEntry,
  JournalEntryBody,
  JournalEntryId,
  JournalEntryJsonSchema,
  type WrittenDuring,
} from "./journal-entry.ts";
import { schemaResult } from "./schema-result.ts";
import { SessionId } from "./session.ts";
import { DeletedTag, TagName } from "./tag.ts";
import type { TimerState } from "./timer-state.ts";

const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
/** セッションを始めてからの経過 */
const at = (minutes: number, seconds = 0) =>
  new Date(STARTED_AT + minutes * 60_000 + seconds * 1000);

const sessionId = v.parse(SessionId.schema, uuid(0));
const entryId = v.parse(JournalEntryId.schema, uuid(901));
const body = (text: string) => v.parse(JournalEntryBody.schema, text);
const tag = (name: string) => v.parse(TagName.schema, name);

/** 時刻 `now` に `state` のとき、本文「メモ」を書く */
const writing = (state: TimerState, now: Date, tags: ReadonlyArray<TagName> = []) => ({
  id: entryId,
  body: body("メモ"),
  tags,
  sessionId,
  state,
  now,
});

/** 1ラウンド目の1セット目の集中が3分たったとき（開始から3分） */
const focusing: TimerState = {
  kind: "Focus",
  round: 1,
  setNumber: 1,
  completedSets: 0,
  remainingSeconds: 240,
  clock: { kind: "Running", endsAt: at(7) },
};

const written = (writtenDuring: WrittenDuring, now: Date, tags: string[] = []) =>
  ({
    kind: "Success",
    value: {
      id: entryId,
      sessionId,
      body: "メモ",
      tags,
      writtenAt: now,
      updatedAt: now,
      writtenDuring,
    },
  }) as const;

goldenCases(
  "JournalEntry.write",
  (input: Parameters<typeof JournalEntry.write>[0]) => settled(JournalEntry.write(input)),
  [
    {
      name: "集中中に書くと、ラウンド・セット・集中に紐付く",
      input: writing(focusing, at(3)),
      expected: written({ kind: "Focus", round: 1, setNumber: 1 }, at(3)),
    },
    {
      name: "ジャーナル中に書くと、そのセットのジャーナルに紐付く",
      input: writing(
        {
          kind: "Journal",
          round: 1,
          setNumber: 2,
          completedSets: 2,
          remainingSeconds: 30,
          clock: { kind: "Running", endsAt: at(16) },
        },
        at(15, 30),
      ),
      expected: written({ kind: "Journal", round: 1, setNumber: 2 }, at(15, 30)),
    },
    {
      name: "休憩中に書くと、ラウンドと休憩に紐付き、セットには紐付かない",
      input: writing(
        {
          kind: "Break",
          round: 1,
          completedSets: 3,
          remainingSeconds: 180,
          clock: { kind: "Running", endsAt: at(29) },
        },
        at(26),
      ),
      expected: written({ kind: "Break", round: 1 }, at(26)),
    },
    {
      name: "待機中に書くと、フェーズには紐付かず、次にやり直すセットに紐付く",
      input: writing({ kind: "Idle", round: 1, setNumber: 2, completedSets: 1 }, at(11)),
      expected: written({ kind: "Idle", round: 1, setNumber: 2 }, at(11)),
    },
    {
      name: "切り替え待ちの間に書くと、時間が過ぎて終わったフェーズに紐付く",
      input: writing(
        {
          kind: "AwaitingAdvance",
          finished: { kind: "Focus", round: 1, setNumber: 1 },
          completedSets: 1,
          since: at(7),
        },
        at(9),
      ),
      expected: written({ kind: "Focus", round: 1, setNumber: 1 }, at(9)),
    },
    {
      name: "終了したセッションには書けない",
      input: writing({ kind: "Ended", endedAt: at(5), endedBy: "End", completedSets: 0 }, at(6)),
      expected: { kind: "Failure", error: { kind: "NoSessionInProgress" } },
    },
    {
      name: "自動終了の時刻を過ぎたセッションには書けない",
      input: writing(
        { kind: "Ended", endedAt: at(0), endedBy: "AutoEnd", completedSets: 0 },
        at(58),
      ),
      expected: { kind: "Failure", error: { kind: "NoSessionInProgress" } },
    },
    {
      name: "書いた時刻と更新時刻は、書いた時刻になり、つけたタグはそのまま残る",
      input: writing(focusing, at(3), [tag("読書"), tag("設計")]),
      expected: written({ kind: "Focus", round: 1, setNumber: 1 }, at(3), ["読書", "設計"]),
    },
  ],
);

const focusEntry = {
  id: entryId,
  sessionId,
  body: body("メモ"),
  tags: [],
  writtenAt: at(3),
  updatedAt: at(3),
  writtenDuring: { kind: "Focus", round: 1, setNumber: 1 },
} as const satisfies Parameters<typeof JournalEntry.edit>[0];

goldenCases(
  "JournalEntry.edit",
  (input: {
    entry: Parameters<typeof JournalEntry.edit>[0];
    change: Parameters<typeof JournalEntry.edit>[1];
    now: Date;
  }) => JournalEntry.edit(input.entry, input.change, input.now),
  [
    {
      name: "本文・タグと更新時刻だけが変わり、書いた時刻と紐付きは変わらない",
      input: {
        entry: focusEntry,
        change: { body: body("直した"), tags: [tag("読書")] },
        now: at(30),
      },
      expected: {
        id: entryId,
        sessionId,
        body: "直した",
        tags: ["読書"],
        writtenAt: at(3),
        updatedAt: at(30),
        writtenDuring: { kind: "Focus", round: 1, setNumber: 1 },
      },
    },
  ],
);

goldenCases(
  "JournalEntry.deleteTag",
  (input: { entry: Parameters<typeof JournalEntry.edit>[0]; deleted: DeletedTag }) =>
    JournalEntry.deleteTag(input.entry, input.deleted),
  [
    {
      name: "記入からタグを外しても、本文・書いた時刻・更新時刻は変わらない（編集済みにならない）",
      input: {
        entry: { ...focusEntry, tags: [tag("読書")] },
        deleted: { name: tag("読書"), deletion: { kind: "Detach" } },
      },
      expected: {
        id: entryId,
        sessionId,
        body: "メモ",
        tags: [],
        writtenAt: at(3),
        updatedAt: at(3),
        writtenDuring: { kind: "Focus", round: 1, setNumber: 1 },
      },
    },
  ],
);

const parseBody: (input: Readonly<{ value: unknown }>) => Parsed<string> = (input) => {
  const parsed = parsedBy(JournalEntryBody.schema)(input);
  return parsed.kind === "Success" ? { kind: "Success", value: parsed.value.unwrap() } : parsed;
};

goldenCases("JournalEntryBody.parse", parseBody, [
  {
    name: "前後の空白を落とし、改行は残す",
    input: { value: "  1行目\n2行目\n " },
    expected: { kind: "Success", value: "1行目\n2行目" },
  },
  {
    name: "空の本文は書けない",
    input: { value: "" },
    expected: { kind: "Failure", error: { kind: "Invalid" } },
  },
  {
    name: "空白と改行だけの本文は書けない",
    input: { value: "  \n  " },
    expected: { kind: "Failure", error: { kind: "Invalid" } },
  },
]);

describe("本文", () => {
  test("本文は PII なので、JSON にすると伏せられる", () => {
    expect(JSON.stringify({ body: body("秘密のメモ") })).toBe('{"body":"[REDACTED]"}');
  });

  test("応答の JSON では本文を取り出し、スキーマで検証すると Sensitive に包み直す", () => {
    const overTheWire: unknown = JSON.parse(JSON.stringify(JournalEntry.toJson(focusEntry)));
    const parsed = schemaResult(JournalEntryJsonSchema)(overTheWire);

    expect(overTheWire).toMatchObject({ body: "メモ" });
    expect(Result.isSuccess(parsed) && parsed.value.body.unwrap()).toBe("メモ");
    expect(Result.isSuccess(parsed) && parsed.value.writtenAt).toEqual(at(3));
  });
});
