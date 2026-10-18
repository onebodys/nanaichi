import { describe, expect, test } from "vite-plus/test";
import {
  remainingRatioOf,
  roundProgressOf,
  setsUntilBreakOf,
  upcomingPhaseOf,
} from "./round-progress.ts";
import type { TimerState } from "./timer-state.ts";

const running = { kind: "Running", endsAt: new Date(0) } as const;
const paused = { kind: "Paused", pausedAt: new Date(0) } as const;

const focus = (setNumber: number, remainingSeconds: number, round = 1) =>
  ({
    kind: "Focus",
    round,
    setNumber,
    completedSets: setNumber - 1,
    remainingSeconds,
    clock: running,
  }) as const satisfies TimerState;

const journal = (setNumber: number, round = 1) =>
  ({
    kind: "Journal",
    round,
    setNumber,
    completedSets: setNumber,
    remainingSeconds: 30,
    clock: running,
  }) as const satisfies TimerState;

const breakOf = (remainingSeconds: number, round = 1) =>
  ({
    kind: "Break",
    round,
    completedSets: 3,
    remainingSeconds,
    clock: running,
  }) as const satisfies TimerState;

describe("フェーズの残り時間の割合", () => {
  test("集中を始めたばかりなら残りは全部で、7分のうち4分12秒残っていれば6割", () => {
    expect(remainingRatioOf(focus(1, 7 * 60))).toBe(1);
    expect(remainingRatioOf(focus(1, 4 * 60 + 12))).toBeCloseTo(0.6);
  });

  test("ジャーナルは1分、休憩は5分を全体として割合を出す", () => {
    expect(remainingRatioOf(journal(1))).toBe(0.5);
    expect(remainingRatioOf(breakOf(150))).toBe(0.5);
  });

  test("一時停止中は止めたときの残り時間の割合のまま", () => {
    expect(remainingRatioOf({ ...focus(2, 210), clock: paused })).toBe(0.5);
  });
});

describe("次に移るフェーズ", () => {
  test("集中の次は同じセットのジャーナル", () => {
    expect(upcomingPhaseOf(focus(2, 100))).toEqual({ kind: "Journal", round: 1, setNumber: 2 });
  });

  test("1・2セット目のジャーナルの次は、次のセットの集中", () => {
    expect(upcomingPhaseOf(journal(2))).toEqual({ kind: "Focus", round: 1, setNumber: 3 });
  });

  test("3セット目のジャーナルの次は休憩", () => {
    expect(upcomingPhaseOf(journal(3))).toEqual({ kind: "Break", round: 1 });
  });

  test("休憩の次は次のラウンドの1セット目の集中", () => {
    expect(upcomingPhaseOf(breakOf(60, 2))).toEqual({ kind: "Focus", round: 3, setNumber: 1 });
  });
});

describe("ラウンドの進み具合", () => {
  test("2セット目の集中中は、1セット目を終え、2セット目を進めていて、3セット目と休憩はまだ", () => {
    const progress = roundProgressOf(focus(2, 4 * 60 + 12));
    expect(progress.sets[0]).toEqual({ kind: "Done" });
    expect(progress.sets[1]?.kind).toBe("Current");
    expect(progress.sets[1]?.kind === "Current" && progress.sets[1].elapsedRatio).toBeCloseTo(0.4);
    expect(progress.sets[2]).toEqual({ kind: "Pending" });
    expect(progress.break).toEqual({ kind: "Pending" });
    expect(setsUntilBreakOf(progress)).toBe(2);
  });

  test("ジャーナル中はそのセットの集中を終えたとみなし、休憩まであと何セットが減る", () => {
    const progress = roundProgressOf(journal(2));
    expect(progress.sets.map((segment) => segment.kind)).toEqual(["Done", "Done", "Pending"]);
    expect(setsUntilBreakOf(progress)).toBe(1);
  });

  test("休憩中は3セットとも終えていて、休憩を進めている", () => {
    const progress = roundProgressOf(breakOf(200));
    expect(progress.sets.map((segment) => segment.kind)).toEqual(["Done", "Done", "Done"]);
    expect(progress.break).toEqual({ kind: "Current", elapsedRatio: 1 - 200 / 300 });
    expect(setsUntilBreakOf(progress)).toBe(0);
  });

  test("集中中に中断して待機になると、中断したセットはまだに戻る", () => {
    const progress = roundProgressOf({ kind: "Idle", round: 1, setNumber: 2, completedSets: 1 });
    expect(progress.sets.map((segment) => segment.kind)).toEqual(["Done", "Pending", "Pending"]);
    expect(setsUntilBreakOf(progress)).toBe(2);
  });
});
