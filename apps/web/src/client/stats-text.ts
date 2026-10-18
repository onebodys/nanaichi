import { FocusTime } from "../domain/focus-time.ts";
import type { StatsActivity, StatsPeriod, StatsReport } from "../domain/stats.ts";
import { focusTimeLabelOf } from "./focus-time-text.ts";
import { dateLabelOf } from "./journal-text.ts";

/** スタッツ（GLOSSARY）の文言。判断はせず、ドメインの値を言葉にするだけ（AGENTS.md §5） */

type Active = Extract<StatsActivity, { kind: "Active" }>;

export const periodLabelOf = (period: StatsPeriod): string => {
  switch (period) {
    case "Today":
      return "今日";
    case "Week":
      return "週";
    case "Month":
      return "月";
    case "All":
      return "すべて";
  }
};

/** 期間の見出し（`10月12日（月）〜 10月18日（日）`、月なら `2026年10月`） */
export const rangeLabelOf = (report: StatsReport): string => {
  const { from, to } = report.range;
  switch (report.period) {
    case "Today":
      return dateLabelOf(from);
    case "Week":
      return `${dateLabelOf(from)} 〜 ${dateLabelOf(to)}`;
    case "Month":
      return `${from.year}年${from.month}月`;
    case "All":
      return `${from.year}年${dateLabelOf(from)} 〜 今日`;
  }
};

/** 完了セット数の集中時間（`7時間49分`） */
export const focusTimeOfSetsLabel = (completedSets: number): string =>
  focusTimeLabelOf(FocusTime.ofCompletedSets(completedSets));

const previousLabelOf = (period: StatsPeriod): string => {
  switch (period) {
    case "Today":
      return "昨日の同じ時刻";
    case "Week":
      return "先週の同じ時点";
    case "Month":
    case "All":
      return "先月の同じ時点";
  }
};

/**
 * 前の期間の同じ時点までとの集中時間の差（`先週の同じ時点より +52分`）。比べられなければ出さない
 */
export const comparisonLabelOf = (period: StatsPeriod, activity: Active): string | undefined => {
  if (activity.comparison.kind === "NotCompared") {
    return undefined;
  }
  const diff = activity.completedSets - activity.comparison.previousCompletedSets;
  const previous = previousLabelOf(period);
  if (diff === 0) {
    return `${previous}と同じ`;
  }
  return `${previous}より ${diff > 0 ? "+" : "−"}${focusTimeOfSetsLabel(Math.abs(diff))}`;
};

/** 割合（`88%`）。もとになる数がなければ `—` */
const percentLabelOf = (part: number, whole: number): string =>
  whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;

/** 完了率（GLOSSARY） */
export const completionRateLabelOf = (activity: Active): string =>
  percentLabelOf(activity.completedSets, activity.completedSets + activity.abortedSets);

/** 記入率（GLOSSARY） */
export const entryRateLabelOf = (activity: Active): string =>
  percentLabelOf(activity.completedSetsWithEntry, activity.completedSets);

/**
 * この12週間の集中の、1日の濃さ（0〜4）。1ラウンド（3セット）ごとに1段濃くし、3ラウンドで最も濃くする
 */
export const heatLevelOf = (completedSets: number): 0 | 1 | 2 | 3 | 4 => {
  if (completedSets === 0) {
    return 0;
  }
  if (completedSets < 3) {
    return 1;
  }
  if (completedSets < 6) {
    return 2;
  }
  if (completedSets < 9) {
    return 3;
  }
  return 4;
};

/** いちばん完了セットの多い時間帯（`14時台`）。同じなら早い時間。完了セットがなければ出さない */
export const peakHourLabelOf = (hours: ReadonlyArray<number>): string | undefined => {
  const max = Math.max(...hours);
  return max === 0 ? undefined : `${hours.indexOf(max)}時台`;
};

/** 期間の中に記録がないときの見出し */
export const noActivityTitleOf = (period: StatsPeriod): string => {
  switch (period) {
    case "Today":
      return "今日の記録はまだありません";
    case "Week":
      return "今週の記録はまだありません";
    case "Month":
      return "今月の記録はまだありません";
    case "All":
      return "まだ記録がありません";
  }
};
