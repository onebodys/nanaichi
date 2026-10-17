import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import type { SessionEvents } from "./session-event.ts";
import { phaseChangeBetween } from "./phase-change.ts";
import { deriveTimerState, type TimerState } from "./timer-state.ts";

const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
const at = (minutes: number, seconds = 0) =>
  new Date(STARTED_AT + minutes * 60_000 + seconds * 1000);

const start = [{ kind: "Start", at: at(0) }] as const satisfies SessionEvents;

const stateAt = (events: SessionEvents, now: Date): TimerState => {
  const derived = deriveTimerState(events, now, []);
  if (Result.isFailure(derived)) {
    throw new Error(`状態を計算できなかった: ${derived.error.kind}`);
  }
  return derived.value;
};

/** 同じ操作イベントから、2つの時刻の状態を計算して比べる */
const changeBetween = (events: SessionEvents, from: Date, to: Date) =>
  phaseChangeBetween(stateAt(events, from), stateAt(events, to));

describe("フェーズの切り替わり", () => {
  test("集中の時間が過ぎてジャーナルに移ったら、切り替わりとして知らせる", () => {
    expect(changeBetween(start, at(6, 59), at(7))).toMatchObject({
      kind: "PhaseChanged",
      to: { kind: "Journal", round: 1, setNumber: 1 },
    });
  });

  test("ジャーナルの時間が過ぎて次のセットの集中に移ったら、切り替わりとして知らせる", () => {
    expect(changeBetween(start, at(7, 59), at(8))).toMatchObject({
      kind: "PhaseChanged",
      to: { kind: "Focus", round: 1, setNumber: 2 },
    });
  });

  test("3セット目のジャーナルが終わって休憩に移ったら、切り替わりとして知らせる", () => {
    expect(changeBetween(start, at(23, 59), at(24))).toMatchObject({
      kind: "PhaseChanged",
      to: { kind: "Break", round: 1 },
    });
  });

  test("休憩が終わって次のラウンドの集中に移ったら、切り替わりとして知らせる", () => {
    expect(changeBetween(start, at(28, 59), at(29))).toMatchObject({
      kind: "PhaseChanged",
      to: { kind: "Focus", round: 2, setNumber: 1 },
    });
  });

  test("同じフェーズのまま残り時間が減っただけなら、切り替わりではない", () => {
    expect(changeBetween(start, at(1), at(2))).toEqual({ kind: "Unchanged" });
  });

  test("一時停止中は時間が過ぎてもフェーズが進まないので、切り替わりではない", () => {
    const paused = [...start, { kind: "Pause", at: at(6) }] as const satisfies SessionEvents;

    expect(changeBetween(paused, at(6, 30), at(20))).toEqual({ kind: "Unchanged" });
  });

  test("間のフェーズを飛ばしたときは、最後に移った先だけを知らせる", () => {
    // 端末がスリープしていて、集中 → ジャーナル → 次の集中 を一度に進めた
    expect(changeBetween(start, at(6), at(9))).toMatchObject({
      kind: "PhaseChanged",
      to: { kind: "Focus", round: 1, setNumber: 2 },
    });
  });

  test("自動終了して終了になったのはフェーズの切り替わりではない", () => {
    expect(changeBetween(start, at(57), at(58))).toEqual({ kind: "Unchanged" });
  });
});
