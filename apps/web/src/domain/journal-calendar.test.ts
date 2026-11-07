import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { goldenCases, type Plain } from "../testing/golden.ts";
import {
  journalEntryOf,
  localDate,
  uuid,
  type JournalEntryFields,
} from "../testing/golden-values.ts";
import {
  EntriesOnDateQuerySchema,
  JournalCalendar,
  JournalCalendarJsonSchema,
  JournalCalendarQuerySchema,
  type JournalCalendarDay,
  type JournalMonth,
} from "./journal-calendar.ts";
import type { JournalEntry } from "./journal-entry.ts";
import type { LocalDate } from "./local-date.ts";
import { schemaResult } from "./schema-result.ts";

const TOKYO = "Asia/Tokyo";
const LOS_ANGELES = "America/Los_Angeles";

/** 番号 `n` の記入。時刻 `iso` に書いた集中中の記入 */
const entryFields = (n: number, iso: string, body: string): JournalEntryFields => ({
  id: uuid(n),
  sessionId: uuid(0),
  body,
  tags: [],
  writtenAt: new Date(iso),
  updatedAt: new Date(iso),
  writtenDuring: { kind: "Focus", round: 1, setNumber: 1 },
});

// 2026-10-20 12:00（日本時間）
const NOW = new Date("2026-10-20T03:00:00Z");
const OCTOBER = { year: 2026, month: 10 };

/**
 * 2026年10月の日ごとの記入の数。`today` 日までは数を、それより後はまだ来ていない日にする。
 * `entries` は日ごとの記入の数で、書いていない日は 0
 */
const octoberDays = (
  today: number,
  entries: Readonly<Record<number, number>>,
): ReadonlyArray<Plain<JournalCalendarDay>> =>
  Array.from({ length: 31 }, (_, i) => {
    const day = i + 1;
    const date = localDate(2026, 10, day);
    return day > today
      ? { kind: "Upcoming", date }
      : { kind: "Day", date, entries: entries[day] ?? 0 };
  });

goldenCases(
  "JournalCalendar.of",
  (input: { month: JournalMonth; writtenAts: ReadonlyArray<Date>; now: Date; timeZone: string }) =>
    JournalCalendar.of(input),
  [
    {
      name: "月の1日から末日まで、日ごとに記入の数を数える",
      input: {
        month: OCTOBER,
        writtenAts: [
          new Date("2026-10-01T01:00:00Z"),
          new Date("2026-10-01T02:00:00Z"),
          new Date("2026-10-15T10:00:00Z"),
        ],
        now: NOW,
        timeZone: TOKYO,
      },
      expected: {
        month: OCTOBER,
        today: localDate(2026, 10, 20),
        days: octoberDays(20, { 1: 2, 15: 1 }),
      },
    },
    {
      name: "今日より後の日は、まだ来ていない日になる",
      input: { month: OCTOBER, writtenAts: [], now: NOW, timeZone: TOKYO },
      expected: {
        month: OCTOBER,
        today: localDate(2026, 10, 20),
        days: octoberDays(20, {}),
      },
    },
    {
      // 2026-10-01 0:30（日本時間）は、ロサンゼルスでは 2026-09-30 8:30
      name: "記入は端末のタイムゾーンで書いた日付に数える（日本時間では10月1日）",
      input: {
        month: OCTOBER,
        writtenAts: [new Date("2026-09-30T15:30:00Z")],
        now: NOW,
        timeZone: TOKYO,
      },
      expected: {
        month: OCTOBER,
        today: localDate(2026, 10, 20),
        days: octoberDays(20, { 1: 1 }),
      },
    },
    {
      // ロサンゼルスの今は 2026-10-19 20:00
      name: "月の外の記入は数えない（ロサンゼルスでは前の月の記入になる）",
      input: {
        month: OCTOBER,
        writtenAts: [new Date("2026-09-30T15:30:00Z")],
        now: NOW,
        timeZone: LOS_ANGELES,
      },
      expected: {
        month: OCTOBER,
        today: localDate(2026, 10, 19),
        days: octoberDays(19, {}),
      },
    },
  ],
);

goldenCases("JournalCalendar.windowOfMonth", JournalCalendar.windowOfMonth, [
  {
    name: "月の記入を読む範囲は、どのタイムゾーンの日付でも含むよう前後1日ずつ広げる",
    input: { year: 2026, month: 2 },
    expected: {
      from: new Date("2026-01-31T00:00:00Z"),
      until: new Date("2026-03-02T00:00:00Z"),
    },
  },
]);

goldenCases("JournalCalendar.monthBefore", JournalCalendar.monthBefore, [
  {
    name: "前の月は年をまたぐ",
    input: { year: 2026, month: 1 },
    expected: { year: 2025, month: 12 },
  },
]);

goldenCases("JournalCalendar.monthAfter", JournalCalendar.monthAfter, [
  {
    name: "次の月は年をまたぐ",
    input: { year: 2026, month: 12 },
    expected: { year: 2027, month: 1 },
  },
]);

goldenCases("JournalCalendar.keyOfMonth", JournalCalendar.keyOfMonth, [
  {
    name: "API のクエリに書く月は、0 で埋めた YYYY-MM",
    input: { year: 2026, month: 3 },
    expected: "2026-03",
  },
]);

describe("ジャーナルのカレンダーの応答", () => {
  test("応答をスキーマで検証して戻せる", () => {
    const calendar = JournalCalendar.of({
      month: OCTOBER,
      writtenAts: [new Date("2026-10-01T01:00:00Z")],
      now: NOW,
      timeZone: TOKYO,
    });

    expect(schemaResult(JournalCalendarJsonSchema)(JSON.parse(JSON.stringify(calendar)))).toEqual(
      Result.succeed(calendar),
    );
  });
});

const morning = entryFields(1, "2026-10-19T23:00:00Z", "朝");
const noon = entryFields(2, "2026-10-20T03:00:00Z", "昼");

goldenCases(
  "JournalCalendar.entriesOn",
  (input: { date: LocalDate; entries: ReadonlyArray<JournalEntry>; timeZone: string }) =>
    JournalCalendar.entriesOn(input),
  [
    {
      name: "その日に書いた記入だけを、書いた順に並べる",
      input: {
        date: localDate(2026, 10, 20),
        entries: [
          journalEntryOf(noon),
          journalEntryOf(entryFields(3, "2026-10-20T15:00:00Z", "次の日")),
          journalEntryOf(morning),
          journalEntryOf(entryFields(4, "2026-10-19T14:00:00Z", "前の日")),
        ],
        timeZone: TOKYO,
      },
      expected: { date: localDate(2026, 10, 20), entries: [morning, noon] },
    },
  ],
);

goldenCases("JournalCalendar.windowOfDate", JournalCalendar.windowOfDate, [
  {
    name: "その日の記入を読む範囲は、前後1日ずつ広げる",
    input: localDate(2026, 10, 20),
    expected: {
      from: new Date("2026-10-19T00:00:00Z"),
      until: new Date("2026-10-22T00:00:00Z"),
    },
  },
]);

describe("クエリ", () => {
  test.each([
    ["2026-10", true],
    ["2026-13", false],
    ["2026-1", false],
  ])("月 %s を受け付けるか: %s", (month, ok) => {
    expect(v.safeParse(JournalCalendarQuerySchema, { month, timeZone: TOKYO }).success).toBe(ok);
  });

  test.each([
    ["2026-10-20", true],
    ["2026-02-29", false],
    ["2028-02-29", true],
    ["2026-10-32", false],
    ["2026/10/20", false],
  ])("日付 %s を受け付けるか: %s", (value, ok) => {
    expect(v.safeParse(EntriesOnDateQuerySchema, { date: value, timeZone: TOKYO }).success).toBe(
      ok,
    );
  });
});
