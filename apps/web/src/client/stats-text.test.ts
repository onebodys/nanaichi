import { describe, expect, test } from "vite-plus/test";
import type { StatsActivity, StatsReport } from "../domain/stats.ts";
import {
  comparisonLabelOf,
  completionRateLabelOf,
  entryRateLabelOf,
  heatLevelOf,
  peakHourLabelOf,
  rangeLabelOf,
} from "./stats-text.ts";

const active = (
  overrides: Partial<Extract<StatsActivity, { kind: "Active" }>>,
): Extract<StatsActivity, { kind: "Active" }> => ({
  kind: "Active",
  completedSets: 10,
  abortedSets: 0,
  comparison: { kind: "NotCompared" },
  entries: 0,
  completedSetsWithEntry: 0,
  trend: { kind: "None" },
  tags: [],
  hours: Array.from({ length: 24 }, () => 0),
  ...overrides,
});

const date = (month: number, day: number) => ({
  key: `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  year: 2026,
  month,
  day,
});

const reportOf = (period: StatsReport["period"], from: number, to: number): StatsReport => ({
  serverTime: new Date(0),
  period,
  today: date(10, to),
  range: { from: date(10, from), to: date(10, to) },
  activity: { kind: "NoActivity" },
  streak: { current: 0, longest: 0 },
  calendar: [],
});

describe("スタッツの文言", () => {
  test("期間の見出しは、週なら月曜から日曜、月なら年と月", () => {
    expect(rangeLabelOf(reportOf("Week", 12, 18))).toBe("10月12日（月） 〜 10月18日（日）");
    expect(rangeLabelOf(reportOf("Month", 1, 31))).toBe("2026年10月");
    expect(rangeLabelOf(reportOf("Today", 14, 14))).toBe("10月14日（水）");
  });

  test("前の期間との差は、集中時間の増減で出す", () => {
    const compared = (previousCompletedSets: number) =>
      active({ completedSets: 10, comparison: { kind: "Compared", previousCompletedSets } });

    expect(comparisonLabelOf("Week", compared(2))).toBe("先週の同じ時点より +56分");
    expect(comparisonLabelOf("Today", compared(19))).toBe("昨日の同じ時刻より −1時間3分");
    expect(comparisonLabelOf("Month", compared(10))).toBe("先月の同じ時点と同じ");
    expect(comparisonLabelOf("All", active({}))).toBeUndefined();
  });

  test("完了率と記入率は四捨五入した百分率で、もとになるセットがなければ —", () => {
    expect(completionRateLabelOf(active({ completedSets: 67, abortedSets: 9 }))).toBe("88%");
    expect(completionRateLabelOf(active({ completedSets: 0, abortedSets: 0 }))).toBe("—");
    expect(entryRateLabelOf(active({ completedSets: 0 }))).toBe("—");
    expect(entryRateLabelOf(active({ completedSets: 3, completedSetsWithEntry: 2 }))).toBe("67%");
  });

  test("12週間の濃さは、1ラウンドごとに1段濃くなる", () => {
    expect([0, 1, 2, 3, 5, 6, 8, 9, 20].map(heatLevelOf)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  test("いちばん集中した時間帯は、同じ数なら早い時間にし、完了セットがなければ出さない", () => {
    const hours = Array.from({ length: 24 }, (_, hour) => (hour === 9 || hour === 14 ? 4 : 1));

    expect(peakHourLabelOf(hours)).toBe("9時台");
    expect(peakHourLabelOf(Array.from({ length: 24 }, () => 0))).toBeUndefined();
  });
});
