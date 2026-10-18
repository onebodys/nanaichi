import type { SessionOperation } from "../domain/session-event.ts";
import { setsUntilBreakOf, type RoundProgress } from "../domain/round-progress.ts";
import { completedSetsAndFocusTimeOf } from "./focus-time-text.ts";
import { timeLabelOf } from "./journal-text.ts";
import {
  phaseDurationMsOf,
  SETS_PER_ROUND,
  type Ended,
  type Phase,
  type TimerState,
} from "../domain/timer-state.ts";

/** 画面に出す文言。判断はせず、ドメインの値を言葉にするだけ（AGENTS.md §5） */

/**
 * 残り秒数をカウントダウンの表示（`m:ss`）の分と秒にする。
 * 等幅の数字の間で「:」だけ幅を詰めて描くため、分けて返す
 */
export const countdownPartsOf = (
  remainingSeconds: number,
): Readonly<{ minutes: string; seconds: string }> => ({
  minutes: String(Math.floor(remainingSeconds / 60)),
  seconds: String(remainingSeconds % 60).padStart(2, "0"),
});

const minutesOf = (phase: Phase): number => phaseDurationMsOf(phase) / 60_000;

/** フェーズの時間が過ぎたら何に移るか（`次は ジャーナル 1分`） */
export const upcomingLabelOf = (upcoming: Phase): string => {
  switch (upcoming.kind) {
    case "Focus":
      return upcoming.setNumber === 1
        ? `次は ${upcoming.round}ラウンド目の集中`
        : `次は 集中（${upcoming.setNumber}セット目）`;
    case "Journal":
      return `次は ジャーナル ${minutesOf(upcoming)}分`;
    case "Break":
      return `次は 休憩 ${minutesOf(upcoming)}分`;
  }
};

/** 休憩まであと何セットか。休憩中は出さない */
export const untilBreakLabelOf = (progress: RoundProgress): string | undefined => {
  const sets = setsUntilBreakOf(progress);
  return sets === 0 ? undefined : `休憩まで あと${sets}セット`;
};

const FIRST_FOCUS = { kind: "Focus", round: 1, setNumber: 1 } as const satisfies Phase;
const FIRST_JOURNAL = { kind: "Journal", round: 1, setNumber: 1 } as const satisfies Phase;
const FIRST_BREAK = { kind: "Break", round: 1 } as const satisfies Phase;

/** 開始前に出す、1セットの流れとラウンドの決まり */
export const sessionRhythmOf = (): Readonly<{
  focusSeconds: number;
  set: string;
  round: string;
}> => ({
  focusSeconds: phaseDurationMsOf(FIRST_FOCUS) / 1000,
  set: `集中 ${minutesOf(FIRST_FOCUS)}分 → ジャーナル ${minutesOf(FIRST_JOURNAL)}分`,
  round: `${SETS_PER_ROUND}セットごとに ${minutesOf(FIRST_BREAK)}分の休憩が入ります`,
});

/** フェーズの名前 */
export const phaseNameOf = (phase: Phase): string => {
  switch (phase.kind) {
    case "Focus":
      return "集中";
    case "Journal":
      return "ジャーナル";
    case "Break":
      return "休憩";
  }
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
    case "AwaitingAdvance":
      return "切り替え待ち";
    case "Ended":
      return "終了";
  }
};

const positionOfPhase = (phase: Phase): string =>
  phase.kind === "Break"
    ? `${phase.round}ラウンド目`
    : `${phase.round}ラウンド目・${phase.setNumber}セット目`;

/**
 * 何ラウンド目・何セット目か。休憩はどのセットにも属さないのでラウンドだけ。
 * 切り替え待ちは、終わったフェーズの位置
 */
export const positionOf = (state: Exclude<TimerState, Ended>): string => {
  switch (state.kind) {
    case "Focus":
    case "Journal":
    case "Idle":
      return `${state.round}ラウンド目・${state.setNumber}セット目`;
    case "Break":
      return `${state.round}ラウンド目`;
    case "AwaitingAdvance":
      return positionOfPhase(state.finished);
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
    case "Advance":
      return "次へ進む";
    case "End":
      return "終了";
  }
};

/** 切り替え待ちから進める操作の文言。何が始まるかで言う（`ジャーナルを始める`） */
export const advanceLabelOf = (next: Phase): string => {
  switch (next.kind) {
    case "Focus":
      return "集中を始める";
    case "Journal":
      return "ジャーナルを始める";
    case "Break":
      return "休憩に入る";
  }
};

/**
 * 切り替え待ちで出す、何が終わったかと待っている時間（`集中が終わりました · 2分13秒前`）。1分未満は秒だけ
 */
export const awaitingLabelOf = (finished: Phase, since: Date, now: Date): string => {
  const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const ago =
    minutes === 0 ? `${seconds}秒前` : `${minutes}分${String(seconds % 60).padStart(2, "0")}秒前`;
  return `${phaseNameOf(finished)}が終わりました · ${ago}`;
};

/** フェーズの切り替わりを知らせる通知の文言 */
export const phaseChangeMessageOf = (to: Phase): Readonly<{ title: string; body: string }> => {
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

/** 中断のあとの待機で出す説明。待機は中断の直後にだけなる（GLOSSARY の「待機」） */
export const idleMessageOf = (setNumber: number): Readonly<{ title: string; body: string }> => ({
  title: `${setNumber}セット目を中断しました`,
  body: `集中を再開始すると、${setNumber}セット目の集中をはじめからやり直します`,
});

/** セッション中にタイマーの下に出す、このセッションの積み上げ（`このセッション 13:05〜 · 完了 4セット · 集中 28分`） */
export const currentSessionLabelOf = (startedAt: Date, completedSets: number): string =>
  `このセッション ${timeLabelOf(startedAt)}〜 · ${completedSetsAndFocusTimeOf(completedSets)}`;

/** 一時停止中に出す、止めてからの時間（`止めてから 2分13秒`）。1分未満は秒だけ */
export const pausedForLabelOf = (pausedAt: Date, now: Date): string => {
  const seconds = Math.max(0, Math.floor((now.getTime() - pausedAt.getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0
    ? `止めてから ${seconds}秒`
    : `止めてから ${minutes}分${String(seconds % 60).padStart(2, "0")}秒`;
};

/** セッションのまとめの、始めた時刻と終わった時刻（`13:05 〜 15:02`） */
export const sessionSpanLabelOf = (startedAt: Date, endedAt: Date): string =>
  `${timeLabelOf(startedAt)} 〜 ${timeLabelOf(endedAt)}`;

/** セットの並びの点線の説明。不成立セットがなければ出さない */
export const abortedSetsNoteOf = (abortedSets: number): string | undefined =>
  abortedSets === 0 ? undefined : `点線は不成立セット（${abortedSets}セット）`;

/** 終了の文言。自動終了なら、記入も操作もないまま時間が過ぎたことを伝える */
export const endedMessageOf = (endedBy: Ended["endedBy"]): string =>
  endedBy === "AutoEnd"
    ? "記入も操作もないまま時間が過ぎたので、セッションを自動終了しました"
    : "セッションを終了しました";
