import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { goldenCases } from "../testing/golden.ts";
import {
  journalEntryOf,
  localDate,
  uuid,
  type JournalEntryFields,
} from "../testing/golden-values.ts";
import type { JournalEntry } from "./journal-entry.ts";
import { JournalPeriod, JournalPeriodQuerySchema } from "./journal-period.ts";

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

const oneDay = (day: ReturnType<typeof localDate>, timeZone: string) => ({
  from: day,
  to: day,
  timeZone,
});

goldenCases("JournalPeriod.rangeOf", JournalPeriod.rangeOf, [
  {
    name: "from の日の 0:00 から、to の翌日の 0:00 の手前までを、タイムゾーンで区切る",
    input: {
      from: localDate(2026, 10, 12),
      to: localDate(2026, 10, 18),
      timeZone: "Asia/Tokyo",
    },
    expected: {
      from: new Date("2026-10-11T15:00:00Z"),
      until: new Date("2026-10-18T15:00:00Z"),
    },
  },
  {
    // ニューヨークは 2026-03-08 の 2:00 に夏時間に入る（-05:00 → -04:00）
    name: "夏時間に切り替わる日も、その日の 0:00 から数える",
    input: oneDay(localDate(2026, 3, 8), "America/New_York"),
    expected: {
      from: new Date("2026-03-08T05:00:00Z"),
      until: new Date("2026-03-09T04:00:00Z"),
    },
  },
  {
    // サンティアゴは 2026-09-06 の 0:00 が 1:00 に飛ぶ（-04:00 → -03:00）
    name: "0:00 が夏時間で飛ぶ日は、その日の最初の時刻から数える",
    input: oneDay(localDate(2026, 9, 6), "America/Santiago"),
    expected: {
      from: new Date("2026-09-06T04:00:00Z"),
      until: new Date("2026-09-07T03:00:00Z"),
    },
  },
  {
    name: "年をまたぐ期間でも、to の翌日まで数える",
    input: oneDay(localDate(2026, 12, 31), "UTC"),
    expected: {
      from: new Date("2026-12-31T00:00:00Z"),
      until: new Date("2027-01-01T00:00:00Z"),
    },
  },
]);

describe("期間の指定の検証", () => {
  const periodOf = (from: string, to: string, timeZone: string) => ({ from, to, timeZone });

  test.each([
    ["from が to より後", periodOf("2026-10-02", "2026-10-01", "UTC")],
    ["期間が 366 日より長い", periodOf("2026-01-01", "2027-01-02", "UTC")],
    ["暦にない日付", periodOf("2026-02-29", "2026-03-01", "UTC")],
    ["YYYY-MM-DD ではない", periodOf("2026/10/01", "2026-10-01", "UTC")],
    ["タイムゾーンではない", periodOf("2026-10-01", "2026-10-01", "Tokyo")],
  ])("%s期間は受け付けない", (_, query) => {
    expect(v.safeParse(JournalPeriodQuerySchema, query).success).toBe(false);
  });

  test("1日だけの期間と、366 日の期間は受け付ける", () => {
    expect(
      v.safeParse(JournalPeriodQuerySchema, periodOf("2028-02-29", "2028-02-29", "UTC")).success,
    ).toBe(true);
    expect(
      v.safeParse(JournalPeriodQuerySchema, periodOf("2026-01-01", "2027-01-01", "UTC")).success,
    ).toBe(true);
  });
});

goldenCases(
  "JournalPeriod.report",
  (input: JournalPeriod & { entries: ReadonlyArray<JournalEntry> }) =>
    JournalPeriod.report(
      { from: input.from, to: input.to, timeZone: input.timeZone },
      input.entries,
    ),
  [
    {
      name: "記入に、書いた日付と時刻を期間のタイムゾーンで添える",
      input: {
        from: localDate(2026, 10, 19),
        to: localDate(2026, 10, 20),
        timeZone: "Asia/Tokyo",
        entries: [
          journalEntryOf(entryFields(1, "2026-10-19T00:05:00Z", "朝")),
          journalEntryOf(entryFields(2, "2026-10-19T15:30:00Z", "日付が変わってから")),
        ],
      },
      expected: {
        period: {
          from: localDate(2026, 10, 19),
          to: localDate(2026, 10, 20),
          timeZone: "Asia/Tokyo",
        },
        entries: [
          {
            ...entryFields(1, "2026-10-19T00:05:00Z", "朝"),
            writtenOn: "2026-10-19",
            writtenAtLocalTime: "09:05",
          },
          {
            ...entryFields(2, "2026-10-19T15:30:00Z", "日付が変わってから"),
            writtenOn: "2026-10-20",
            writtenAtLocalTime: "00:30",
          },
        ],
      },
    },
  ],
);

goldenCases("JournalPeriod.toJson", JournalPeriod.toJson, [
  {
    name: "JSON にすると、本文を取り出し、期間を日付の文字列にする",
    input: {
      period: oneDay(localDate(2026, 10, 19), "Asia/Tokyo"),
      entries: [
        {
          ...journalEntryOf(entryFields(1, "2026-10-19T00:05:00Z", "本文")),
          writtenOn: "2026-10-19",
          writtenAtLocalTime: "09:05",
        },
      ],
    },
    expected: {
      period: { from: "2026-10-19", to: "2026-10-19", timeZone: "Asia/Tokyo" },
      entries: [
        {
          ...entryFields(1, "2026-10-19T00:05:00Z", "本文"),
          writtenOn: "2026-10-19",
          writtenAtLocalTime: "09:05",
        },
      ],
    },
  },
]);
