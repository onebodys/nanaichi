import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import {
  EntriesOnDateQuerySchema,
  JournalCalendar,
  JournalCalendarJsonSchema,
  JournalCalendarQuerySchema,
} from "./journal-calendar.ts";
import { JournalEntryBody, JournalEntryId, type JournalEntry } from "./journal-entry.ts";
import { Calendar } from "./local-date.ts";
import { schemaResult } from "./schema-result.ts";
import { SessionId } from "./session.ts";

const TOKYO = "Asia/Tokyo";
const LOS_ANGELES = "America/Los_Angeles";

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, "0")}`;
const sessionId = v.parse(SessionId.schema, uuid());

const entryAt = (writtenAt: Date, text = "メモ"): JournalEntry => ({
  id: v.parse(JournalEntryId.schema, uuid()),
  sessionId,
  body: v.parse(JournalEntryBody.schema, text),
  tags: [],
  writtenAt,
  updatedAt: writtenAt,
  writtenDuring: { kind: "Focus", round: 1, setNumber: 1 },
});

const date = (year: number, month: number, day: number) =>
  Calendar.dateOfDayNumber(Calendar.dayNumberOf({ key: "", year, month, day }));

// 2026-10-20 12:00（日本時間）
const NOW = new Date("2026-10-20T03:00:00Z");

describe("ジャーナルのカレンダー", () => {
  test("月の1日から末日まで、日ごとに記入の数を数える", () => {
    const calendar = JournalCalendar.of({
      month: { year: 2026, month: 10 },
      writtenAts: [
        new Date("2026-10-01T01:00:00Z"),
        new Date("2026-10-01T02:00:00Z"),
        new Date("2026-10-15T10:00:00Z"),
      ],
      now: NOW,
      timeZone: TOKYO,
    });

    expect(calendar.days).toHaveLength(31);
    expect(calendar.days[0]).toEqual({ kind: "Day", date: date(2026, 10, 1), entries: 2 });
    expect(calendar.days[14]).toEqual({ kind: "Day", date: date(2026, 10, 15), entries: 1 });
    expect(calendar.days[1]).toEqual({ kind: "Day", date: date(2026, 10, 2), entries: 0 });
    expect(calendar.today).toEqual(date(2026, 10, 20));
  });

  test("今日より後の日は、まだ来ていない日になる", () => {
    const calendar = JournalCalendar.of({
      month: { year: 2026, month: 10 },
      writtenAts: [],
      now: NOW,
      timeZone: TOKYO,
    });

    expect(calendar.days[19]).toMatchObject({ kind: "Day", date: date(2026, 10, 20) });
    expect(calendar.days[20]).toEqual({ kind: "Upcoming", date: date(2026, 10, 21) });
  });

  test("記入は端末のタイムゾーンで書いた日付に数え、月の外の記入は数えない", () => {
    // 2026-10-01 0:30（日本時間）は、ロサンゼルスでは 2026-09-30 8:30
    const writtenAts = [new Date("2026-09-30T15:30:00Z")];
    const month = { year: 2026, month: 10 };

    const inTokyo = JournalCalendar.of({ month, writtenAts, now: NOW, timeZone: TOKYO });
    const inLosAngeles = JournalCalendar.of({ month, writtenAts, now: NOW, timeZone: LOS_ANGELES });

    expect(inTokyo.days[0]).toMatchObject({ entries: 1 });
    expect(inLosAngeles.days.every((day) => day.kind === "Upcoming" || day.entries === 0)).toBe(
      true,
    );
  });

  test("月の記入を読む範囲は、どのタイムゾーンの日付でも含むよう前後1日ずつ広げる", () => {
    expect(JournalCalendar.windowOfMonth({ year: 2026, month: 2 })).toEqual({
      from: new Date("2026-01-31T00:00:00Z"),
      until: new Date("2026-03-02T00:00:00Z"),
    });
  });

  test("前の月・次の月は年をまたぐ", () => {
    expect(JournalCalendar.monthBefore({ year: 2026, month: 1 })).toEqual({
      year: 2025,
      month: 12,
    });
    expect(JournalCalendar.monthAfter({ year: 2026, month: 12 })).toEqual({ year: 2027, month: 1 });
    expect(JournalCalendar.keyOfMonth({ year: 2026, month: 3 })).toBe("2026-03");
  });

  test("応答をスキーマで検証して戻せる", () => {
    const calendar = JournalCalendar.of({
      month: { year: 2026, month: 10 },
      writtenAts: [new Date("2026-10-01T01:00:00Z")],
      now: NOW,
      timeZone: TOKYO,
    });

    expect(schemaResult(JournalCalendarJsonSchema)(JSON.parse(JSON.stringify(calendar)))).toEqual(
      Result.succeed(calendar),
    );
  });
});

describe("選んだ日の記入", () => {
  test("その日に書いた記入だけを、書いた順に並べる", () => {
    const morning = entryAt(new Date("2026-10-19T23:00:00Z"), "朝");
    const noon = entryAt(new Date("2026-10-20T03:00:00Z"), "昼");
    const yesterday = entryAt(new Date("2026-10-19T14:00:00Z"), "前の日");
    const tomorrow = entryAt(new Date("2026-10-20T15:00:00Z"), "次の日");

    const found = JournalCalendar.entriesOn({
      date: date(2026, 10, 20),
      entries: [noon, tomorrow, morning, yesterday],
      timeZone: TOKYO,
    });

    expect(found.entries.map((entry) => entry.body.unwrap())).toEqual(["朝", "昼"]);
  });

  test("その日の記入を読む範囲は、前後1日ずつ広げる", () => {
    expect(JournalCalendar.windowOfDate(date(2026, 10, 20))).toEqual({
      from: new Date("2026-10-19T00:00:00Z"),
      until: new Date("2026-10-22T00:00:00Z"),
    });
  });
});

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
