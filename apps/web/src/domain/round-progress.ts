import type { InPhase } from "./phase-change.ts";
import {
  nextPhase,
  phaseDurationMsOf,
  SETS_PER_ROUND,
  type Ended,
  type Phase,
  type TimerState,
} from "./timer-state.ts";

/**
 * ラウンドの中の1区切り（セットの集中、または休憩）の進み具合。
 *
 * - `Done`: 終えた。セットは集中を最後まで終えていれば、ジャーナル中や切り替え待ちでも終えたとみなす
 * - `Current`: 進めているところ。`elapsedRatio` は経過した割合（0〜1）
 * - `Pending`: まだ。中断したセットは、やり直すまでまだとみなす
 */
export type Segment =
  | Readonly<{ kind: "Done" }>
  | Readonly<{ kind: "Current"; elapsedRatio: number }>
  | Readonly<{ kind: "Pending" }>;

/** いまのラウンドの進み具合。セットごと（ラウンドのセット数だけ並ぶ）と、最後の休憩 */
export type RoundProgress = Readonly<{
  sets: ReadonlyArray<Segment>;
  break: Segment;
}>;

const DONE = { kind: "Done" } as const satisfies Segment;
const PENDING = { kind: "Pending" } as const satisfies Segment;

const phaseOf = (state: InPhase): Phase =>
  state.kind === "Break"
    ? { kind: "Break", round: state.round }
    : { kind: state.kind, round: state.round, setNumber: state.setNumber };

/** フェーズの残り時間の割合（1 = 始まったばかり、0 = 終わる）。一時停止中は止めたときの割合 */
export const remainingRatioOf = (state: InPhase): number =>
  (state.remainingSeconds * 1000) / phaseDurationMsOf(phaseOf(state));

/** フェーズの時間が過ぎたときに移る先（GLOSSARY の「フェーズの切り替わり」） */
export const upcomingPhaseOf = (state: InPhase): Phase => nextPhase(phaseOf(state));

/** セット番号 `setNumber` のセットが、いまの状態でどこまで進んでいるか */
const setSegmentOf = (state: Exclude<TimerState, Ended>, setNumber: number): Segment => {
  switch (state.kind) {
    case "Break":
      return DONE;
    case "Idle":
      return setNumber < state.setNumber ? DONE : PENDING;
    case "Journal":
      return setNumber <= state.setNumber ? DONE : PENDING;
    case "AwaitingAdvance":
      // 終わったフェーズまでは終えている。休憩のあとの切り替え待ちなら、このラウンドはすべて終えた
      return state.finished.kind === "Break" || setNumber <= state.finished.setNumber
        ? DONE
        : PENDING;
    case "Focus":
      if (setNumber < state.setNumber) return DONE;
      if (setNumber > state.setNumber) return PENDING;
      return { kind: "Current", elapsedRatio: 1 - remainingRatioOf(state) };
  }
};

const breakSegmentOf = (state: Exclude<TimerState, Ended>): Segment => {
  if (state.kind === "Break") {
    return { kind: "Current", elapsedRatio: 1 - remainingRatioOf(state) };
  }
  return state.kind === "AwaitingAdvance" && state.finished.kind === "Break" ? DONE : PENDING;
};

/** いまのラウンドの進み具合。待機・一時停止中も、その時点までの進み具合を返す */
export const roundProgressOf = (state: Exclude<TimerState, Ended>): RoundProgress => ({
  sets: Array.from({ length: SETS_PER_ROUND }, (_, i) => setSegmentOf(state, i + 1)),
  break: breakSegmentOf(state),
});

/** 休憩に入るまでに、あと何セット（進めているセットを含む）。休憩中は 0 */
export const setsUntilBreakOf = (progress: RoundProgress): number =>
  progress.sets.filter((segment) => segment.kind !== "Done").length;
