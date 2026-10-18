import { FocusTime } from "../domain/focus-time.ts";
import type { DayCompletedSets } from "../domain/timeline.ts";

/** 集中時間（GLOSSARY）の文言。判断はせず、ドメインの値を言葉にするだけ（AGENTS.md §5） */

const hoursAndMinutesOf = (ms: number): Readonly<{ hours: number; minutes: number }> => {
  const totalMinutes = Math.floor(ms / 60_000);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
};

/** 集中時間（`1時間10分`、1時間に満たなければ `42分`） */
export const focusTimeLabelOf = (ms: number): string => {
  const { hours, minutes } = hoursAndMinutesOf(ms);
  return hours === 0 ? `${minutes}分` : `${hours}時間${minutes}分`;
};

/** スマホのヘッダーに出す短い集中時間（`1:10`） */
export const focusTimeShortLabelOf = (ms: number): string => {
  const { hours, minutes } = hoursAndMinutesOf(ms);
  return `${hours}:${String(minutes).padStart(2, "0")}`;
};

/** 完了セットの数と、その集中時間（`完了 4セット · 集中 28分`） */
export const completedSetsAndFocusTimeOf = (completedSets: number): string =>
  `完了 ${completedSets}セット · 集中 ${focusTimeLabelOf(FocusTime.ofCompletedSets(completedSets))}`;

/** ヘッダーに出す今日の集中時間。タイムラインを読み込むまで・数が確定するまでは出さない */
export type TodayFocus = DayCompletedSets | Readonly<{ kind: "Loading" }>;

export const todayFocusOf = (
  today: TodayFocus,
):
  | Readonly<{ kind: "Counted"; long: string; short: string; sets: string }>
  | Readonly<{ kind: "Unknown" }> => {
  switch (today.kind) {
    case "Counted": {
      const ms = FocusTime.ofCompletedSets(today.count);
      return {
        kind: "Counted",
        long: focusTimeLabelOf(ms),
        short: focusTimeShortLabelOf(ms),
        sets: `${today.count}セット`,
      };
    }
    case "NotYetCounted":
    case "Loading":
      return { kind: "Unknown" };
  }
};

/** セッションの区切りに添える、そのセッションのその日の積み上げ。完了セットがなければ出さない */
export const daySessionStatsOf = (completedSets: number): string | undefined =>
  completedSets === 0 ? undefined : completedSetsAndFocusTimeOf(completedSets);
