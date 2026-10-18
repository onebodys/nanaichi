import { nextPhase, type Phase, type TimerState } from "./timer-state.ts";

/** フェーズのどれかにあるタイマーの状態（待機・切り替え待ち・終了を除く） */
export type InPhase = Extract<TimerState, Readonly<{ kind: "Focus" | "Journal" | "Break" }>>;

/**
 * 2つの時刻のタイマーの状態を比べた結果（GLOSSARY の「フェーズの切り替わり」）。
 *
 * - `PhaseChanged`: 別のフェーズに移った。`to` は移った先のフェーズ。
 *   進め方が手動の切り替わりで切り替え待ちになったときも、これから移る先のフェーズとして知らせる（ADR 0015）
 * - `Unchanged`: 同じフェーズのまま（一時停止しただけ、残り時間が減っただけを含む）か、
 *   フェーズのない状態（待機・終了）になった
 */
export type PhaseChange =
  | Readonly<{ kind: "PhaseChanged"; to: Phase }>
  | Readonly<{ kind: "Unchanged" }>;

/** その状態が向かっているフェーズ。フェーズの中ならそのフェーズ、切り替え待ちなら次に始まるフェーズ */
const headingOf = (state: TimerState): Phase | undefined => {
  switch (state.kind) {
    case "Focus":
    case "Journal":
      return { kind: state.kind, round: state.round, setNumber: state.setNumber };
    case "Break":
      return { kind: state.kind, round: state.round };
    case "AwaitingAdvance":
      return nextPhase(state.finished);
    case "Idle":
    case "Ended":
      return undefined;
  }
};

/** 同じフェーズかどうかを見分ける。セットの集中・ジャーナルはセット番号まで、休憩はラウンドまでで決まる */
const phaseKeyOf = (phase: Phase): string => {
  switch (phase.kind) {
    case "Focus":
    case "Journal":
      return `${phase.kind}:${phase.round}:${phase.setNumber}`;
    case "Break":
      return `${phase.kind}:${phase.round}`;
  }
};

/**
 * `previous` から `current` へのフェーズの切り替わり。
 *
 * 同じ操作イベントから計算した、前後2つの時刻の状態を渡す。その間に人の操作はないので、
 * フェーズが変わっていれば時間が過ぎたことによる切り替わりで、知らせる対象になる。
 * 人の操作で変わった状態どうしを比べてはいけない（本人が押したので知らせない）。
 *
 * 切り替え待ちは次に始まるフェーズに向かっているものとして比べる。切り替え待ちになったときに知らせ、
 * 進めて次のフェーズが始まったときは同じフェーズなので知らせない。
 * 端末がスリープしていたなどで間のフェーズを飛ばしたときは、最後に移った先だけを返す。
 */
export const phaseChangeBetween = (previous: TimerState, current: TimerState): PhaseChange => {
  const to = headingOf(current);
  if (to === undefined) {
    return { kind: "Unchanged" };
  }
  const from = headingOf(previous);
  if (from !== undefined && phaseKeyOf(from) === phaseKeyOf(to)) {
    return { kind: "Unchanged" };
  }
  return { kind: "PhaseChanged", to };
};
