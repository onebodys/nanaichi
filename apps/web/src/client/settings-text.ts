import type { InPhase } from "../domain/phase-change.ts";
import type { AlertTone, Volume } from "./alert-settings.ts";
import type { NotificationPermissionState } from "./phase-alert.ts";
import type { ThemePreference } from "./theme.ts";
import type { Ended, TimerState } from "../domain/timer-state.ts";
import { countdownPartsOf, phaseLabelOf } from "./timer-text.ts";

/** 設定画面の文言。判断はせず、設定の値を言葉にするだけ（AGENTS.md §5） */

export const volumeLabelOf = (volume: Volume): string => {
  switch (volume) {
    case "Low":
      return "小";
    case "Medium":
      return "中";
    case "High":
      return "大";
  }
};

export const toneLabelOf = (tone: AlertTone): string => {
  switch (tone) {
    case "Bell":
      return "鐘";
    case "Marimba":
      return "木琴";
    case "Electronic":
      return "電子音";
    case "Soft":
      return "やわらか";
  }
};

/**
 * 音色を選ぶ行の見出しと補足。行き先のフェーズで分ける
 * （ジャーナルの終わりは集中にも休憩にも行くので、「何が終わったとき」では分けられない）
 */
export const toneTargetOf = (
  to: InPhase["kind"],
): Readonly<{ label: string; description: string }> => {
  switch (to) {
    case "Journal":
      return { label: "ジャーナルに入るとき", description: "集中が終わり、書く時間になる合図" };
    case "Focus":
      return {
        label: "集中に入るとき",
        description: "ジャーナルや休憩が終わり、次の集中が始まる合図",
      };
    case "Break":
      return { label: "休憩に入るとき", description: "ラウンドの最後のジャーナルが終わった合図" };
  }
};

/** 音色を選ぶ行の並び。1セットの流れの順にする */
export const TONE_TARGETS = ["Journal", "Focus", "Break"] as const satisfies ReadonlyArray<
  InPhase["kind"]
>;

export const themeLabelOf = (preference: ThemePreference): string => {
  switch (preference) {
    case "System":
      return "端末に合わせる";
    case "Light":
      return "ライト";
    case "Dark":
      return "ダーク";
  }
};

/** ブラウザ通知の許可の状態の説明。通知を出さない設定のときは出さない */
export const permissionNoteOf = (permission: NotificationPermissionState): string => {
  switch (permission) {
    case "granted":
      return "ブラウザで許可されています";
    case "default":
      return "セッションを開始するときに、ブラウザが許可を求めます";
    case "denied":
      return "ブラウザで通知が拒否されています。ブラウザのサイトの設定から許可してください";
    case "unsupported":
      return "このブラウザは通知に対応していません";
  }
};

/** 設定画面のヘッダーに出す、セッション中に裏で進んでいるタイマーの様子（`集中 4:12`） */
export const backgroundTimerLabelOf = (state: Exclude<TimerState, Ended>): string => {
  if (state.kind === "Idle") {
    return phaseLabelOf(state);
  }
  const { minutes, seconds } = countdownPartsOf(state.remainingSeconds);
  const paused = state.clock.kind === "Paused" ? "（一時停止中）" : "";
  return `${phaseLabelOf(state)} ${minutes}:${seconds}${paused}`;
};
