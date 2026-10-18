import type { WrittenDuring } from "../domain/journal-entry.ts";
import type { DayCompletedSets, LocalDate } from "../domain/timeline.ts";

/** タイムラインに出す文言。判断はせず、ドメインの値を言葉にするだけ（AGENTS.md §5） */

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 日付の区切りの見出し（`10月17日（土）`） */
export const dateLabelOf = (date: LocalDate): string => {
  // 曜日は日付だけで決まるので、タイムゾーンに関係なく UTC の暦で数える
  const weekday = WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
  return `${date.month}月${date.day}日（${weekday}）`;
};

export const completedSetsLabelOf = (completedSets: DayCompletedSets): string => {
  switch (completedSets.kind) {
    case "Counted":
      return `完了セット ${completedSets.count}`;
    case "NotYetCounted":
      return "完了セットは続きを読み込むと出ます";
  }
};

/** 端末のタイムゾーンでの時刻（`23:05`） */
export const timeLabelOf = (at: Date): string =>
  at.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

/** 記入を書いたときのタイマーの状態 */
export const writtenDuringLabelOf = (writtenDuring: WrittenDuring): string => {
  switch (writtenDuring.kind) {
    case "Focus":
      return `${writtenDuring.round}ラウンド目・${writtenDuring.setNumber}セット目・集中`;
    case "Journal":
      return `${writtenDuring.round}ラウンド目・${writtenDuring.setNumber}セット目・ジャーナル`;
    case "Break":
      return `${writtenDuring.round}ラウンド目・休憩`;
    case "Idle":
      return `${writtenDuring.round}ラウンド目・${writtenDuring.setNumber}セット目・待機`;
  }
};

/**
 * 記入を書いたときのタイマーの状態を、タイムラインのバッジ用に短くしたもの（`2-1 ジャーナル` は
 * 2ラウンド目・1セット目のジャーナル）。読み上げには `writtenDuringLabelOf` の長い文言を使う
 */
export const writtenDuringBadgeOf = (writtenDuring: WrittenDuring): string => {
  switch (writtenDuring.kind) {
    case "Focus":
      return `${writtenDuring.round}-${writtenDuring.setNumber} 集中`;
    case "Journal":
      return `${writtenDuring.round}-${writtenDuring.setNumber} ジャーナル`;
    case "Break":
      return "休憩";
    case "Idle":
      return `${writtenDuring.round}-${writtenDuring.setNumber} 待機`;
  }
};
