import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { JournalEntryBody, JournalEntryId, type JournalEntry } from "./journal-entry.ts";
import { schemaResult } from "./schema-result.ts";
import { SessionId } from "./session.ts";
import { TagName } from "./tag.ts";
import {
  TaggedEntries,
  TaggedEntriesPageJsonSchema,
  TaggedEntriesQuerySchema,
} from "./tagged-entries.ts";

const TOKYO = "Asia/Tokyo";
const reading = v.parse(TagName.schema, "読書");

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, "0")}`;
const sessionId = v.parse(SessionId.schema, uuid());

const entryAt = (iso: string, text = iso): JournalEntry => ({
  id: v.parse(JournalEntryId.schema, uuid()),
  sessionId,
  body: v.parse(JournalEntryBody.schema, text),
  tags: [reading],
  writtenAt: new Date(iso),
  updatedAt: new Date(iso),
  writtenDuring: { kind: "Journal", round: 1, setNumber: 2 },
});

describe("タグのついた記入のページ", () => {
  test("1件多く読めていれば、いちばん古い記入の時刻から次のページを読む", () => {
    const found = [
      entryAt("2026-10-20T03:00:00Z"),
      entryAt("2026-10-19T03:00:00Z"),
      entryAt("2026-10-18T03:00:00Z"),
    ];

    const page = TaggedEntries.page(reading, found, 2);

    expect(page.entries).toEqual(found.slice(0, 2));
    expect(page.next).toEqual({ kind: "More", before: new Date("2026-10-19T03:00:00Z") });
  });

  test("読めた数がページの大きさまでなら、これより古い記入はない", () => {
    const found = [entryAt("2026-10-20T03:00:00Z")];

    expect(TaggedEntries.page(reading, found, 2).next).toEqual({ kind: "End" });
  });

  test("続きのページを足すと、同じ記入は1つにして新しい順に並べる", () => {
    const newer = entryAt("2026-10-20T03:00:00Z");
    const older = entryAt("2026-10-18T03:00:00Z");

    expect(TaggedEntries.merge([newer], [older, newer])).toEqual([newer, older]);
  });

  test("書いた日付（端末のタイムゾーン）ごとに、新しい日付から区切る", () => {
    // 2026-10-20 0:30 と 2026-10-19 23:30（日本時間）
    const afterMidnight = entryAt("2026-10-19T15:30:00Z", "日付が変わったあと");
    const beforeMidnight = entryAt("2026-10-19T14:30:00Z", "日付が変わる前");
    const sameDay = entryAt("2026-10-19T01:00:00Z", "同じ日の朝");

    const days = TaggedEntries.byDate([sameDay, afterMidnight, beforeMidnight], TOKYO);

    expect(days.map((day) => day.date.key)).toEqual(["2026-10-20", "2026-10-19"]);
    expect(days[1]?.entries.map((entry) => entry.body.unwrap())).toEqual([
      "日付が変わる前",
      "同じ日の朝",
    ]);
  });

  test("応答をスキーマで検証して戻せる", () => {
    const page = TaggedEntries.page(reading, [entryAt("2026-10-20T03:00:00Z", "本文")], 20);

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
