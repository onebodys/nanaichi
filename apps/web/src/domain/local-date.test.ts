import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import {
  LocalDateJsonSchema,
  LocalDateKeySchema,
  startOfDayIn,
  type LocalDate,
} from "./local-date.ts";

const dateOf = (year: number, month: number, day: number): LocalDate => ({
  key: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  year,
  month,
  day,
});

describe("日付が始まる時刻", () => {
  const startOf = (timeZone: string, date: LocalDate) => startOfDayIn(timeZone)(date).toISOString();

  test("東京の日付は、前日の UTC 15:00 に始まる", () => {
    expect(startOf("Asia/Tokyo", dateOf(2026, 10, 20))).toBe("2026-10-19T15:00:00.000Z");
  });

  test("0:00 が夏時間で飛ぶ日は、その日の最初の時刻（1:00）に始まる", () => {
    expect(startOf("Africa/Cairo", dateOf(2026, 4, 24))).toBe("2026-04-23T22:00:00.000Z");
  });

  test("夏時間の切り替わりで候補が2つ日付に入るときは、早いほうに始まる", () => {
    expect(startOf("America/Godthab", dateOf(2026, 3, 29))).toBe("2026-03-29T01:00:00.000Z");
  });

  test("日付そのものが飛んだ日は、飛んだあとの最初の時刻に始まる", () => {
    expect(startOf("Pacific/Apia", dateOf(2011, 12, 30))).toBe("2011-12-30T10:00:00.000Z");
  });
});

describe("JSON にした日付", () => {
  const parse = (input: unknown) => v.safeParse(LocalDateJsonSchema, input);

  test("key が年月日と合う日付は検証して戻せる", () => {
    expect(parse(dateOf(2026, 10, 20))).toMatchObject({ success: true });
  });

  test("key が年月日と合わない日付は通さない", () => {
    expect(parse({ ...dateOf(2026, 10, 20), key: "2026-10-21" }).success).toBe(false);
  });
});

describe("日付のクエリ", () => {
  const parse = (input: string) => v.safeParse(LocalDateKeySchema, input);

  test.each([
    ["2026-10-20", true],
    ["2026-02-28", true],
    ["2026-02-30", false],
    ["2026-13-01", false],
    ["2026-00-10", false],
    ["2026-10-00", false],
    ["2026-10-201", false],
  ])("日付 %s を受け付けるか: %s", (key, ok) => {
    expect(parse(key).success).toBe(ok);
  });
});
