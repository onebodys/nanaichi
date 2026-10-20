import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { JournalEntryBody, JournalEntryId, type JournalEntry } from "./journal-entry.ts";
import { JournalPeriod, JournalPeriodQuerySchema } from "./journal-period.ts";
import { SessionId } from "./session.ts";

const periodOf = (from: string, to: string, timeZone: string) =>
  v.parse(JournalPeriodQuerySchema, { from, to, timeZone });

const entryAt = (iso: string, body: string): JournalEntry => ({
  id: v.parse(JournalEntryId.schema, crypto.randomUUID()),
  sessionId: v.parse(SessionId.schema, crypto.randomUUID()),
  body: v.parse(JournalEntryBody.schema, body),
  tags: [],
  writtenAt: new Date(iso),
  updatedAt: new Date(iso),
  writtenDuring: { kind: "Focus", round: 1, setNumber: 1 },
});

describe("期間の時刻の範囲", () => {
  test("from の日の 0:00 から、to の翌日の 0:00 の手前までを、タイムゾーンで区切る", () => {
    const range = JournalPeriod.rangeOf(periodOf("2026-10-12", "2026-10-18", "Asia/Tokyo"));

    expect(range).toEqual({
      since: new Date("2026-10-11T15:00:00Z"),
      until: new Date("2026-10-18T15:00:00Z"),
    });
  });

  test("夏時間に切り替わる日も、その日の 0:00 から数える", () => {
    // ニューヨークは 2026-03-08 の 2:00 に夏時間に入る（-05:00 → -04:00）
    const range = JournalPeriod.rangeOf(periodOf("2026-03-08", "2026-03-08", "America/New_York"));

    expect(range).toEqual({
      since: new Date("2026-03-08T05:00:00Z"),
      until: new Date("2026-03-09T04:00:00Z"),
    });
  });

  test("0:00 が夏時間で飛ぶ日は、その日の最初の時刻から数える", () => {
    // サンティアゴは 2026-09-06 の 0:00 が 1:00 に飛ぶ（-04:00 → -03:00）
    const range = JournalPeriod.rangeOf(periodOf("2026-09-06", "2026-09-06", "America/Santiago"));

    expect(range.since).toEqual(new Date("2026-09-06T04:00:00Z"));
  });

  test("年をまたぐ期間でも、to の翌日まで数える", () => {
    const range = JournalPeriod.rangeOf(periodOf("2026-12-31", "2026-12-31", "UTC"));

    expect(range.until).toEqual(new Date("2027-01-01T00:00:00Z"));
  });
});

describe("期間の指定の検証", () => {
  test.each([
    ["from が to より後", { from: "2026-10-02", to: "2026-10-01", timeZone: "UTC" }],
    ["期間が 366 日より長い", { from: "2026-01-01", to: "2027-01-02", timeZone: "UTC" }],
    ["暦にない日付", { from: "2026-02-29", to: "2026-03-01", timeZone: "UTC" }],
    ["YYYY-MM-DD ではない", { from: "2026/10/01", to: "2026-10-01", timeZone: "UTC" }],
    ["タイムゾーンではない", { from: "2026-10-01", to: "2026-10-01", timeZone: "Tokyo" }],
  ])("%s期間は受け付けない", (_, query) => {
    expect(v.safeParse(JournalPeriodQuerySchema, query).success).toBe(false);
  });

  test("1日だけの期間と、366 日の期間は受け付ける", () => {
    expect(
      v.safeParse(JournalPeriodQuerySchema, {
        from: "2028-02-29",
        to: "2028-02-29",
        timeZone: "UTC",
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(JournalPeriodQuerySchema, {
        from: "2026-01-01",
        to: "2027-01-01",
        timeZone: "UTC",
      }).success,
    ).toBe(true);
  });
});

describe("期間のジャーナル記入", () => {
  test("記入に、書いた日付と時刻を期間のタイムゾーンで添える", () => {
    const period = periodOf("2026-10-19", "2026-10-20", "Asia/Tokyo");

    const report = JournalPeriod.report(period, [
      entryAt("2026-10-19T00:05:00Z", "朝"),
      entryAt("2026-10-19T15:30:00Z", "日付が変わってから"),
    ]);

    expect(
      report.entries.map(({ writtenOn, writtenAtLocalTime }) => [writtenOn, writtenAtLocalTime]),
    ).toEqual([
      ["2026-10-19", "09:05"],
      ["2026-10-20", "00:30"],
    ]);
  });

  test("JSON にすると、本文を取り出し、期間を日付の文字列にする", () => {
    const period = periodOf("2026-10-19", "2026-10-19", "Asia/Tokyo");

    const json = JournalPeriod.toJson(
      JournalPeriod.report(period, [entryAt("2026-10-19T00:05:00Z", "本文")]),
    );

    expect(json.period).toEqual({ from: "2026-10-19", to: "2026-10-19", timeZone: "Asia/Tokyo" });
    expect(json.entries[0]?.body).toBe("本文");
  });
});
