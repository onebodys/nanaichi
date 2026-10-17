import type { SessionOperation } from "../domain/session-event.ts";
import type { InPhase } from "../domain/phase-change.ts";
import type { Ended, TimerState } from "../domain/timer-state.ts";

/** 画面に出す文言。判断はせず、ドメインの値を言葉にするだけ（AGENTS.md §5） */

/** 残り秒数をカウントダウンの表示（`m:ss`）にする */
export const formatCountdown = (remainingSeconds: number): string => {
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export const phaseLabelOf = (state: TimerState): string => {
  switch (state.kind) {
    case "Focus":
      return "集中";
    case "Journal":
      return "ジャーナル";
    case "Break":
      return "休憩";
    case "Idle":
      return "待機";
    case "Ended":
      return "終了";
  }
};

/** 何ラウンド目・何セット目か。休憩はどのセットにも属さないのでラウンドだけ */
export const positionOf = (state: Exclude<TimerState, Ended>): string => {
  switch (state.kind) {
    case "Focus":
    case "Journal":
    case "Idle":
      return `${state.round}ラウンド目・${state.setNumber}セット目`;
    case "Break":
      return `${state.round}ラウンド目`;
  }
};

export const operationLabelOf = (kind: SessionOperation["kind"]): string => {
  switch (kind) {
    case "Pause":
      return "一時停止";
    case "Resume":
      return "再開";
    case "Abort":
      return "中断";
    case "RestartFocus":
      return "集中を再開始";
    case "SkipBreak":
      return "休憩をスキップ";
    case "End":
      return "終了";
  }
};

/** フェーズの切り替わりを知らせる通知の文言 */
export const phaseChangeMessageOf = (to: InPhase): Readonly<{ title: string; body: string }> => {
  switch (to.kind) {
    case "Focus":
      return {
        title: "集中の時間です",
        body: `${to.round}ラウンド目・${to.setNumber}セット目の集中を始めます`,
      };
    case "Journal":
      return {
        title: "ジャーナルの時間です",
        body: `${to.round}ラウンド目・${to.setNumber}セット目の振り返りと、次にやることの整理`,
      };
    case "Break":
      return { title: "休憩の時間です", body: `${to.round}ラウンド目が終わりました` };
  }
};
