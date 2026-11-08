import { goldenCases } from "../testing/golden.ts";
import type { InPhase } from "./phase-change.ts";
import {
  remainingRatioOf,
  roundProgressOf,
  setsUntilBreakOf,
  upcomingPhaseOf,
  type RoundProgress,
} from "./round-progress.ts";
import type { Ended, TimerState } from "./timer-state.ts";

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

type InPhaseInput = Readonly<{ state: InPhase }>;

goldenCases("remainingRatioOf", (i: InPhaseInput) => remainingRatioOf(i.state), [
  {
    name: "集中を始めたばかりなら残りは全部",
    input: { state: focus(1, 7 * 60) },
    expected: 1,
  },
  {
    name: "7分のうち4分12秒残っていれば6割",
    input: { state: focus(1, 4 * 60 + 12) },
    expected: 0.6,
  },
  {
    name: "ジャーナルは1分を全体として割合を出す",
    input: { state: journal(1) },
    expected: 0.5,
  },
  {
    name: "休憩は5分を全体として割合を出す",
    input: { state: breakOf(150) },
    expected: 0.5,
  },
  {
    name: "一時停止中は止めたときの残り時間の割合のまま",
    input: { state: { ...focus(2, 210), clock: paused } },
    expected: 0.5,
  },
]);

goldenCases("upcomingPhaseOf", (i: InPhaseInput) => upcomingPhaseOf(i.state), [
  {
    name: "集中の次は同じセットのジャーナル",
    input: { state: focus(2, 100) },
    expected: { kind: "Journal", round: 1, setNumber: 2 },
  },
  {
    name: "1・2セット目のジャーナルの次は、次のセットの集中",
    input: { state: journal(2) },
    expected: { kind: "Focus", round: 1, setNumber: 3 },
  },
  {
    name: "3セット目のジャーナルの次は休憩",
    input: { state: journal(3) },
    expected: { kind: "Break", round: 1 },
  },
  {
    name: "休憩の次は次のラウンドの1セット目の集中",
    input: { state: breakOf(60, 2) },
    expected: { kind: "Focus", round: 3, setNumber: 1 },
  },
]);

goldenCases(
  "roundProgressOf",
  (i: Readonly<{ state: Exclude<TimerState, Ended> }>) => roundProgressOf(i.state),
  [
    {
      name: "2セット目の集中中は、1セット目を終え、2セット目を進めていて、3セット目と休憩はまだ",
      input: { state: focus(2, 4 * 60 + 12) },
      expected: {
        sets: [{ kind: "Done" }, { kind: "Current", elapsedRatio: 0.4 }, { kind: "Pending" }],
        break: { kind: "Pending" },
      },
    },
    {
      name: "ジャーナル中はそのセットの集中を終えたとみなす",
      input: { state: journal(2) },
      expected: {
        sets: [{ kind: "Done" }, { kind: "Done" }, { kind: "Pending" }],
        break: { kind: "Pending" },
      },
    },
    {
      name: "休憩中は3セットとも終えていて、休憩を進めている",
      input: { state: breakOf(200) },
      expected: {
        sets: [{ kind: "Done" }, { kind: "Done" }, { kind: "Done" }],
        break: { kind: "Current", elapsedRatio: 1 - 200 / 300 },
      },
    },
    {
      name: "集中中に中断して待機になると、中断したセットはまだに戻る",
      input: { state: { kind: "Idle", round: 1, setNumber: 2, completedSets: 1 } },
      expected: {
        sets: [{ kind: "Done" }, { kind: "Pending" }, { kind: "Pending" }],
        break: { kind: "Pending" },
      },
    },
    {
      name: "集中のあとの切り替え待ちでは、そのセットを終えたとみなす",
      input: {
        state: {
          kind: "AwaitingAdvance",
          finished: { kind: "Focus", round: 1, setNumber: 2 },
          completedSets: 2,
          since: new Date(0),
        },
      },
      expected: {
        sets: [{ kind: "Done" }, { kind: "Done" }, { kind: "Pending" }],
        break: { kind: "Pending" },
      },
    },
    {
      name: "休憩のあとの切り替え待ちでは、休憩までこのラウンドをすべて終えたとみなす",
      input: {
        state: {
          kind: "AwaitingAdvance",
          finished: { kind: "Break", round: 1 },
          completedSets: 3,
          since: new Date(0),
        },
      },
      expected: {
        sets: [{ kind: "Done" }, { kind: "Done" }, { kind: "Done" }],
        break: { kind: "Done" },
      },
    },
  ],
);

goldenCases(
  "setsUntilBreakOf",
  (i: Readonly<{ progress: RoundProgress }>) => setsUntilBreakOf(i.progress),
  [
    {
      name: "2セット目の集中中は、休憩まであと2セット",
      input: {
        progress: {
          sets: [{ kind: "Done" }, { kind: "Current", elapsedRatio: 0.4 }, { kind: "Pending" }],
          break: { kind: "Pending" },
        },
      },
      expected: 2,
    },
    {
      name: "ジャーナル中はそのセットを終えたとみなすので、休憩まであと何セットが減る",
      input: {
        progress: {
          sets: [{ kind: "Done" }, { kind: "Done" }, { kind: "Pending" }],
          break: { kind: "Pending" },
        },
      },
      expected: 1,
    },
    {
      name: "休憩中は休憩まであと0セット",
      input: {
        progress: {
          sets: [{ kind: "Done" }, { kind: "Done" }, { kind: "Done" }],
          break: { kind: "Current", elapsedRatio: 1 - 200 / 300 },
        },
      },
      expected: 0,
    },
    {
      name: "集中中に中断して待機になると、中断したセットが数えなおされる",
      input: {
        progress: {
          sets: [{ kind: "Done" }, { kind: "Pending" }, { kind: "Pending" }],
          break: { kind: "Pending" },
        },
      },
      expected: 2,
    },
  ],
);
