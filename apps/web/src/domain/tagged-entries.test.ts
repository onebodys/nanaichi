import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { goldenCases } from "../testing/golden.ts";
import {
  journalEntryOf,
  uuid,
  localDate,
  type JournalEntryFields,
} from "../testing/golden-values.ts";
import type { JournalEntry } from "./journal-entry.ts";
import { schemaResult } from "./schema-result.ts";
import { TagName } from "./tag.ts";
import {
  TaggedEntries,
  TaggedEntriesPageJsonSchema,
  TaggedEntriesQuerySchema,
} from "./tagged-entries.ts";

const TOKYO = "Asia/Tokyo";
const reading = v.parse(TagName.schema, "読書");

/** 番号 `n` の記入。時刻 `iso` に書いた、タグ「読書」のついたジャーナルの記入 */
const entryFields = (n: number, iso: string, text = iso): JournalEntryFields => ({
  id: uuid(n),
  sessionId: uuid(0),
  body: text,
  tags: ["読書"],
  writtenAt: new Date(iso),
  updatedAt: new Date(iso),
  writtenDuring: { kind: "Journal", round: 1, setNumber: 2 },
});

const entryAt = (n: number, iso: string, text?: string): JournalEntry =>
  journalEntryOf(entryFields(n, iso, text));

goldenCases(
  "TaggedEntries.page",
  (input: { tag: TagName; found: ReadonlyArray<JournalEntry>; limit: number }) =>
    TaggedEntries.page(input.tag, input.found, input.limit),
  [
    {
      name: "1件多く読めていれば、いちばん古い記入の時刻から次のページを読む",
      input: {
        tag: reading,
        found: [
          entryAt(1, "2026-10-20T03:00:00Z"),
          entryAt(2, "2026-10-19T03:00:00Z"),
          entryAt(3, "2026-10-18T03:00:00Z"),
        ],
        limit: 2,
      },
      expected: {
        tag: "読書",
        entries: [entryFields(1, "2026-10-20T03:00:00Z"), entryFields(2, "2026-10-19T03:00:00Z")],
        next: { kind: "More", before: new Date("2026-10-19T03:00:00Z") },
      },
    },
    {
      name: "読めた数がページの大きさまでなら、これより古い記入はない",
      input: { tag: reading, found: [entryAt(1, "2026-10-20T03:00:00Z")], limit: 2 },
      expected: {
        tag: "読書",
        entries: [entryFields(1, "2026-10-20T03:00:00Z")],
        next: { kind: "End" },
      },
    },
  ],
);

goldenCases(
  "TaggedEntries.merge",
  (input: { loaded: ReadonlyArray<JournalEntry>; more: ReadonlyArray<JournalEntry> }) =>
    TaggedEntries.merge(input.loaded, input.more),
  [
    {
      name: "続きのページを足すと、同じ記入は1つにして新しい順に並べる",
      input: {
        loaded: [entryAt(1, "2026-10-20T03:00:00Z")],
        more: [entryAt(2, "2026-10-18T03:00:00Z"), entryAt(1, "2026-10-20T03:00:00Z")],
      },
      expected: [entryFields(1, "2026-10-20T03:00:00Z"), entryFields(2, "2026-10-18T03:00:00Z")],
    },
  ],
);

goldenCases(
  "TaggedEntries.byDate",
  (input: { entries: ReadonlyArray<JournalEntry>; timeZone: string }) =>
    TaggedEntries.byDate(input.entries, input.timeZone),
  [
    {
      name: "書いた日付（端末のタイムゾーン）ごとに、新しい日付から区切る",
      // 2026-10-20 0:30 と 2026-10-19 23:30（日本時間）
      input: {
        entries: [
          entryAt(1, "2026-10-19T01:00:00Z", "同じ日の朝"),
          entryAt(2, "2026-10-19T15:30:00Z", "日付が変わったあと"),
          entryAt(3, "2026-10-19T14:30:00Z", "日付が変わる前"),
        ],
        timeZone: TOKYO,
      },
      expected: [
        {
          date: localDate(2026, 10, 20),
          entries: [entryFields(2, "2026-10-19T15:30:00Z", "日付が変わったあと")],
        },
        {
          date: localDate(2026, 10, 19),
          entries: [
            entryFields(3, "2026-10-19T14:30:00Z", "日付が変わる前"),
            entryFields(1, "2026-10-19T01:00:00Z", "同じ日の朝"),
          ],
        },
      ],
    },
  ],
);

describe("タグのついた記入のページの応答", () => {
  test("応答をスキーマで検証して戻せる", () => {
    const page = TaggedEntries.page(reading, [entryAt(1, "2026-10-20T03:00:00Z", "本文")], 20);

    const parsed = schemaResult(TaggedEntriesPageJsonSchema)(
      JSON.parse(JSON.stringify(TaggedEntries.toJson(page))),
    );

    // 本文は `Sensitive` に包み直されるので、取り出して比べる
    expect(Result.isSuccess(parsed) && parsed.value.next).toEqual({ kind: "End" });
    expect(Result.isSuccess(parsed) && parsed.value.entries[0]?.body.unwrap()).toBe("本文");
  });
});

describe("クエリ", () => {
  test("タグの名前は記録する形に寄せ、before を省けば最新のページを読む", () => {
    expect(v.parse(TaggedEntriesQuerySchema, { tag: "#Reading" })).toEqual({
      kind: "Latest",
      tag: "reading",
      limit: 21,
    });
  });

  test("before があればそれより前を読む", () => {
    expect(
      v.parse(TaggedEntriesQuerySchema, { tag: "読書", before: "2026-10-20T03:00:00.000Z" }),
    ).toEqual({
      kind: "Before",
      tag: reading,
      before: new Date("2026-10-20T03:00:00Z"),
      limit: 21,
    });
  });

  test.each([
    ["タグがない", {}],
    ["タグが空", { tag: "" }],
    ["before が時刻でない", { tag: "読書", before: "yesterday" }],
  ])("%s と受け付けない", (_, query) => {
    expect(v.safeParse(TaggedEntriesQuerySchema, query).success).toBe(false);
  });
});
