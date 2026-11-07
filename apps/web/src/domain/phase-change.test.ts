import { goldenCases } from "../testing/golden.ts";
import { phaseChangeBetween } from "./phase-change.ts";
import type { TimerState } from "./timer-state.ts";

const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
const at = (minutes: number, seconds = 0) =>
  new Date(STARTED_AT + minutes * 60_000 + seconds * 1000);

const running = (endsAt: Date) => ({ kind: "Running", endsAt }) as const;
const paused = (pausedAt: Date) => ({ kind: "Paused", pausedAt }) as const;

/** 同じ操作イベントから計算した、前後2つの時刻の状態を渡す */
type Input = Readonly<{ previous: TimerState; current: TimerState }>;

const awaitingFocus1 = {
  kind: "AwaitingAdvance",
  finished: { kind: "Focus", round: 1, setNumber: 1 },
  completedSets: 1,
  since: at(7),
} as const satisfies TimerState;

goldenCases("phaseChangeBetween", (i: Input) => phaseChangeBetween(i.previous, i.current), [
  {
    name: "集中の時間が過ぎてジャーナルに移ったら、切り替わりとして知らせる",
    input: {
      previous: {
        kind: "Focus",
        round: 1,
        setNumber: 1,
        completedSets: 0,
        remainingSeconds: 1,
        clock: running(at(7)),
      },
      current: {
        kind: "Journal",
        round: 1,
        setNumber: 1,
        completedSets: 1,
        remainingSeconds: 60,
        clock: running(at(8)),
      },
    },
    expected: { kind: "PhaseChanged", to: { kind: "Journal", round: 1, setNumber: 1 } },
  },
  {
    name: "ジャーナルの時間が過ぎて次のセットの集中に移ったら、切り替わりとして知らせる",
    input: {
      previous: {
        kind: "Journal",
        round: 1,
        setNumber: 1,
        completedSets: 1,
        remainingSeconds: 1,
        clock: running(at(8)),
      },
      current: {
        kind: "Focus",
        round: 1,
        setNumber: 2,
        completedSets: 1,
        remainingSeconds: 7 * 60,
        clock: running(at(15)),
      },
    },
    expected: { kind: "PhaseChanged", to: { kind: "Focus", round: 1, setNumber: 2 } },
  },
  {
    name: "3セット目のジャーナルが終わって休憩に移ったら、切り替わりとして知らせる",
    input: {
      previous: {
        kind: "Journal",
        round: 1,
        setNumber: 3,
        completedSets: 3,
        remainingSeconds: 1,
        clock: running(at(24)),
      },
      current: {
        kind: "Break",
        round: 1,
        completedSets: 3,
        remainingSeconds: 5 * 60,
        clock: running(at(29)),
      },
    },
    expected: { kind: "PhaseChanged", to: { kind: "Break", round: 1 } },
  },
  {
    name: "休憩が終わって次のラウンドの集中に移ったら、切り替わりとして知らせる",
    input: {
      previous: {
        kind: "Break",
        round: 1,
        completedSets: 3,
        remainingSeconds: 1,
        clock: running(at(29)),
      },
      current: {
        kind: "Focus",
        round: 2,
        setNumber: 1,
        completedSets: 3,
        remainingSeconds: 7 * 60,
        clock: running(at(36)),
      },
    },
    expected: { kind: "PhaseChanged", to: { kind: "Focus", round: 2, setNumber: 1 } },
  },
  {
    name: "同じフェーズのまま残り時間が減っただけなら、切り替わりではない",
    input: {
      previous: {
        kind: "Focus",
        round: 1,
        setNumber: 1,
        completedSets: 0,
        remainingSeconds: 6 * 60,
        clock: running(at(7)),
      },
      current: {
        kind: "Focus",
        round: 1,
        setNumber: 1,
        completedSets: 0,
        remainingSeconds: 5 * 60,
        clock: running(at(7)),
      },
    },
    expected: { kind: "Unchanged" },
  },
  {
    name: "一時停止中は時間が過ぎてもフェーズが進まないので、切り替わりではない",
    input: {
      previous: {
        kind: "Focus",
        round: 1,
        setNumber: 1,
        completedSets: 0,
        remainingSeconds: 60,
        clock: paused(at(6)),
      },
      current: {
        kind: "Focus",
        round: 1,
        setNumber: 1,
        completedSets: 0,
        remainingSeconds: 60,
        clock: paused(at(6)),
      },
    },
    expected: { kind: "Unchanged" },
  },
  {
    // 端末がスリープしていて、集中 → ジャーナル → 次の集中 を一度に進めた
    name: "間のフェーズを飛ばしたときは、最後に移った先だけを知らせる",
    input: {
      previous: {
        kind: "Focus",
        round: 1,
        setNumber: 1,
        completedSets: 0,
        remainingSeconds: 60,
        clock: running(at(7)),
      },
      current: {
        kind: "Focus",
        round: 1,
        setNumber: 2,
        completedSets: 1,
        remainingSeconds: 6 * 60,
        clock: running(at(15)),
      },
    },
    expected: { kind: "PhaseChanged", to: { kind: "Focus", round: 1, setNumber: 2 } },
  },
  {
    name: "自動終了して終了になったのはフェーズの切り替わりではない",
    input: {
      previous: {
        kind: "Break",
        round: 2,
        completedSets: 6,
        remainingSeconds: 60,
        clock: running(at(58)),
      },
      current: { kind: "Ended", endedAt: at(0), endedBy: "AutoEnd", completedSets: 0 },
    },
    expected: { kind: "Unchanged" },
  },
  {
    name: "フェーズの進め方が手動の切り替わりで、時間が過ぎて切り替え待ちになったら、移る先のフェーズとして知らせる",
    input: {
      previous: {
        kind: "Focus",
        round: 1,
        setNumber: 1,
        completedSets: 0,
        remainingSeconds: 1,
        clock: running(at(7)),
      },
      current: awaitingFocus1,
    },
    expected: { kind: "PhaseChanged", to: { kind: "Journal", round: 1, setNumber: 1 } },
  },
  {
    name: "フェーズの進め方が手動の切り替わりで、切り替え待ちのまま時間が過ぎても、もう一度は知らせない",
    input: { previous: awaitingFocus1, current: awaitingFocus1 },
    expected: { kind: "Unchanged" },
  },
]);
