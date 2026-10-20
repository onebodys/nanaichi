import type { WrittenDuring } from "../domain/journal-entry.ts";
import type { LocalDate } from "../domain/local-date.ts";
import type { DayCompletedSets } from "../domain/timeline.ts";
import { completedSetsAndFocusTimeOf } from "./focus-time-text.ts";

/** タイムラインに出す文言。判断はせず、ドメインの値を言葉にするだけ（AGENTS.md §5） */

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 曜日（`土`）。曜日は日付だけで決まるので、タイムゾーンに関係なく UTC の暦で数える */
export const weekdayLabelOf = (date: LocalDate): string =>
  WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()] ?? "";

/** 日付の区切りの見出し（`10月17日（土）`） */
export const dateLabelOf = (date: LocalDate): string =>
  `${date.month}月${date.day}日（${weekdayLabelOf(date)}）`;

/** ジャーナルのカレンダーの月（`2026年10月`） */
export const monthLabelOf = (month: Readonly<{ year: number; month: number }>): string =>
  `${month.year}年${month.month}月`;

/** 記入の数（`3件`） */
export const entryCountLabelOf = (count: number): string => `${count}件`;

/** ジャーナルのカレンダーの日の読み上げ（`10月20日（火） 記入3件`、記入がなければ `記入なし`） */
export const calendarDayLabelOf = (date: LocalDate, entries: number): string =>
  `${dateLabelOf(date)} ${entries === 0 ? "記入なし" : `記入${entryCountLabelOf(entries)}`}`;

/** 日付の区切りに出す、その日の完了セット数と集中時間（`完了 10セット · 集中 1時間10分`） */
export const completedSetsLabelOf = (completedSets: DayCompletedSets): string => {
  switch (completedSets.kind) {
    case "Counted":
      return completedSetsAndFocusTimeOf(completedSets.count);
    case "NotYetCounted":
      return "完了セットは続きを読み込むと出ます";
  }
};

/** セッションの区切りの見出し（`13:05 からのセッション`）。区切りの名前にも使う */
export const daySessionLabelOf = (startedAt: Date): string =>
  `${timeLabelOf(startedAt)} からのセッション`;

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
