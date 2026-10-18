import type { AdvanceChoice, PhaseTransition } from "../domain/advance-mode.ts";
import type { InPhase } from "../domain/phase-change.ts";
import type { AlertTone, Volume } from "./alert-settings.ts";
import type { NotificationPermissionState } from "./phase-alert.ts";
import type { ThemePreference } from "./theme.ts";
import { nextPhase, type Ended, type TimerState } from "../domain/timer-state.ts";
import { countdownPartsOf, phaseLabelOf, phaseNameOf } from "./timer-text.ts";

/** 設定画面の文言。判断はせず、設定の値を言葉にするだけ（AGENTS.md §5） */

/** フェーズの進め方の行の見出しと補足（GLOSSARY の「フェーズの進め方」） */
export const transitionLabelOf = (
  transition: PhaseTransition,
): Readonly<{ label: string; description: string }> => {
  switch (transition) {
    case "FocusToJournal":
      return { label: "集中 → ジャーナル", description: "集中の7分が終わったとき" };
    case "JournalToFocus":
      return {
        label: "ジャーナル → 集中",
        description: "ジャーナルが終わり、次のセットに進むとき",
      };
    case "JournalToBreak":
      return {
        label: "ジャーナル → 休憩",
        description: "ラウンドの最後のジャーナルが終わったとき",
      };
    case "BreakToFocus":
      return { label: "休憩 → 集中", description: "休憩が終わり、次のラウンドに進むとき" };
  }
};

export const advanceChoiceLabelOf = (choice: AdvanceChoice): string => {
  switch (choice) {
    case "Auto":
      return "自動";
    case "Manual":
      return "手動";
  }
};

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
  if (state.kind === "AwaitingAdvance") {
    return `${phaseNameOf(nextPhase(state.finished))}の前で待っています`;
  }
  const { minutes, seconds } = countdownPartsOf(state.remainingSeconds);
  const paused = state.clock.kind === "Paused" ? "（一時停止中）" : "";
  return `${phaseLabelOf(state)} ${minutes}:${seconds}${paused}`;
};
