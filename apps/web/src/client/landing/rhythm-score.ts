import { remainingRatioOf } from "../../domain/round-progress.ts";
import { SETS_PER_ROUND, type Phase, type TimerState } from "../../domain/timer-state.ts";

/**
 * LP のヒーローの「リズムの帯」。1ラウンドを、集中・ジャーナル・…・休憩の拍（7つ）に分け、
 * それぞれがどこまで進んだか（0〜1）を返す。並びは 集中1 ジャーナル1 集中2 ジャーナル2 集中3 ジャーナル3 休憩。
 *
 * アプリの画面のセットの帯（`roundProgressOf`）はセットごとにまとめて見せるが、LP では
 * 「7分と1分が交互に来る」こと自体を見せたいので、ジャーナルを別の拍として分ける。
 */
const BEATS = SETS_PER_ROUND * 2 + 1;

const beatIndexOf = (phase: Phase): number => {
  switch (phase.kind) {
    case "Focus":
      return (phase.setNumber - 1) * 2;
    case "Journal":
      return (phase.setNumber - 1) * 2 + 1;
    case "Break":
      return BEATS - 1;
  }
};

/** `done` 拍までを終え、`current` 拍が `ratio` まで進んだ帯 */
const filled = (done: number, ratio: number): ReadonlyArray<number> =>
  Array.from({ length: BEATS }, (_, i) => (i < done ? 1 : i === done ? ratio : 0));

export const rhythmBeatsOf = (state: TimerState): ReadonlyArray<number> => {
  switch (state.kind) {
    case "Focus":
    case "Journal":
      return filled(
        beatIndexOf({ kind: state.kind, round: state.round, setNumber: state.setNumber }),
        1 - remainingRatioOf(state),
      );
    case "Break":
      return filled(BEATS - 1, 1 - remainingRatioOf(state));
    case "Idle":
      return filled((state.setNumber - 1) * 2, 0);
    case "AwaitingAdvance":
      return filled(beatIndexOf(state.finished) + 1, 0);
    case "Ended":
      return filled(0, 0);
  }
};
