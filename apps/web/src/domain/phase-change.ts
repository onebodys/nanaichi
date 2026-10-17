import type { TimerState } from "./timer-state.ts";

/** フェーズのどれかにあるタイマーの状態（待機と終了を除く） */
export type InPhase = Extract<TimerState, Readonly<{ kind: "Focus" | "Journal" | "Break" }>>;

/**
 * 2つの時刻のタイマーの状態を比べた結果（GLOSSARY の「フェーズの切り替わり」）。
 *
 * - `PhaseChanged`: 別のフェーズに移った。`to` は移った先のフェーズにある状態
 * - `Unchanged`: 同じフェーズのまま（一時停止しただけ、残り時間が減っただけを含む）か、
 *   フェーズのない状態（待機・終了）になった
 */
export type PhaseChange =
  | Readonly<{ kind: "PhaseChanged"; to: InPhase }>
  | Readonly<{ kind: "Unchanged" }>;

const isInPhase = (state: TimerState): state is InPhase =>
  state.kind === "Focus" || state.kind === "Journal" || state.kind === "Break";

/** 同じフェーズかどうかを見分ける。セットの集中・ジャーナルはセット番号まで、休憩はラウンドまでで決まる */
const phaseKeyOf = (state: InPhase): string => {
  switch (state.kind) {
    case "Focus":
    case "Journal":
      return `${state.kind}:${state.round}:${state.setNumber}`;
    case "Break":
      return `${state.kind}:${state.round}`;
  }
};

/**
 * `previous` から `current` へのフェーズの切り替わり。
 *
 * 同じ操作イベントから計算した、前後2つの時刻の状態を渡す。その間に人の操作はないので、
 * フェーズが変わっていれば時間が過ぎたことによる自動的な切り替わりで、知らせる対象になる。
 * 人の操作で変わった状態どうしを比べてはいけない（本人が押したので知らせない）。
 *
 * 端末がスリープしていたなどで間のフェーズを飛ばしたときは、最後に移った先だけを返す。
 */
export const phaseChangeBetween = (previous: TimerState, current: TimerState): PhaseChange => {
  if (!isInPhase(current)) {
    return { kind: "Unchanged" };
  }
  if (isInPhase(previous) && phaseKeyOf(previous) === phaseKeyOf(current)) {
    return { kind: "Unchanged" };
  }
  return { kind: "PhaseChanged", to: current };
};
