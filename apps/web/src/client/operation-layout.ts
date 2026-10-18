import type { SessionOperation } from "../domain/session-event.ts";

/**
 * 操作ボタンの目立たせ方。
 *
 * - `Primary`: いちばん押される操作。1つだけ
 * - `Secondary`: 止める操作（中断など）。控えめにする
 * - `Quiet`: セッションを閉じる操作（終了）。文字だけにする
 */
type Emphasis = "Primary" | "Secondary" | "Quiet";

type OperationButton = Readonly<{ kind: SessionOperation["kind"]; emphasis: Emphasis }>;

/** 次のフェーズへ進める操作。あればこれを主にする */
const isAdvance = (kind: SessionOperation["kind"]): boolean =>
  kind === "Resume" || kind === "RestartFocus" || kind === "SkipBreak";

const rankOf = (emphasis: Emphasis): number => {
  switch (emphasis) {
    case "Primary":
      return 0;
    case "Secondary":
      return 1;
    case "Quiet":
      return 2;
  }
};

/**
 * その状態でできる操作を、目立たせ方をつけて主な操作から順に並べる（Issue #34 の A 案）。
 *
 * 進める操作（再開・集中の再開始・休憩スキップ）があればそれを主にし、なければ一時停止を主にする。
 * 終了はいつでも最後に、文字だけで置く。
 */
export const operationButtonsOf = (
  operations: ReadonlyArray<SessionOperation["kind"]>,
): ReadonlyArray<OperationButton> => {
  const hasAdvance = operations.some(isAdvance);
  const emphasisOf = (kind: SessionOperation["kind"]): Emphasis => {
    if (kind === "End") return "Quiet";
    if (isAdvance(kind)) return "Primary";
    if (kind === "Pause" && !hasAdvance) return "Primary";
    return "Secondary";
  };
  return operations
    .map((kind) => ({ kind, emphasis: emphasisOf(kind) }))
    .toSorted((a, b) => rankOf(a.emphasis) - rankOf(b.emphasis));
};
