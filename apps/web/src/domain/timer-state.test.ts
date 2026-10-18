import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import type { SessionEvents } from "./session-event.ts";
import {
  deriveCompletedSetTimes,
  deriveSetOutcomes,
  deriveTimerState,
  type TimerState,
} from "./timer-state.ts";

// セッションを始めた時刻からの経過で時刻を書く（`at(7)` は開始から7分後、`at(3, 20)` は3分20秒後）
const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
const at = (minutes: number, seconds = 0) =>
  new Date(STARTED_AT + minutes * 60_000 + seconds * 1000);

const start = [{ kind: "Start", at: at(0) }] as const satisfies SessionEvents;

const derive = (
  events: SessionEvents,
  now: Date,
  journalEntryTimes: ReadonlyArray<Date> = [],
): TimerState => {
  const derived = deriveTimerState(events, now, journalEntryTimes);
  if (Result.isFailure(derived)) {
    throw new Error(`状態を計算できなかった: ${derived.error.kind}`);
  }
  return derived.value;
};

const reject = (events: SessionEvents, now: Date) => {
  const derived = deriveTimerState(events, now, []);
  if (Result.isSuccess(derived)) {
    throw new Error(`受け付けてはいけない操作を受け付けた: ${derived.value.kind}`);
  }
  return derived.error;
};

describe("フェーズの自動的な切り替わり", () => {
  test("開始すると1ラウンド目の1セット目の集中が7分で始まる", () => {
    expect(derive(start, at(0))).toEqual({
      kind: "Focus",
      round: 1,
      setNumber: 1,
      completedSets: 0,
      remainingSeconds: 7 * 60,
      clock: { kind: "Running", endsAt: at(7) },
    });
  });

  test("集中の残り秒数と次の切り替わり時刻がわかる", () => {
    expect(derive(start, at(3, 20))).toMatchObject({
      kind: "Focus",
      remainingSeconds: 3 * 60 + 40,
      clock: { kind: "Running", endsAt: at(7) },
    });
  });

  test("残り秒数は1秒未満の端数を切り上げる", () => {
    expect(derive(start, new Date(at(6, 59).getTime() + 1))).toMatchObject({
      kind: "Focus",
      remainingSeconds: 1,
    });
  });

  test("集中を最後まで終えるとジャーナルに切り替わり、完了セットになる", () => {
    expect(derive(start, at(7))).toEqual({
      kind: "Journal",
      round: 1,
      setNumber: 1,
      completedSets: 1,
      remainingSeconds: 60,
      clock: { kind: "Running", endsAt: at(8) },
    });
  });

  test("ジャーナルが終わると次のセットの集中が始まる", () => {
    expect(derive(start, at(8))).toMatchObject({
      kind: "Focus",
      round: 1,
      setNumber: 2,
      completedSets: 1,
      clock: { kind: "Running", endsAt: at(15) },
    });
  });

  test("3セット目のジャーナルが終わると休憩が5分入る", () => {
    expect(derive(start, at(23, 30))).toMatchObject({
      kind: "Journal",
      round: 1,
      setNumber: 3,
      completedSets: 3,
    });
    expect(derive(start, at(24))).toEqual({
      kind: "Break",
      round: 1,
      completedSets: 3,
      remainingSeconds: 5 * 60,
      clock: { kind: "Running", endsAt: at(29) },
    });
  });

  test("休憩が終わると次のラウンドの1セット目の集中が始まる", () => {
    expect(derive(start, at(29))).toMatchObject({
      kind: "Focus",
      round: 2,
      setNumber: 1,
      completedSets: 3,
      clock: { kind: "Running", endsAt: at(36) },
    });
  });
});

describe("一時停止", () => {
  test("集中中に一時停止すると残り時間が止まり、次の切り替わり時刻を持たない", () => {
    const events = [...start, { kind: "Pause", at: at(3) }] as const satisfies SessionEvents;

    expect(derive(events, at(20))).toEqual({
      kind: "Focus",
      round: 1,
      setNumber: 1,
      completedSets: 0,
      remainingSeconds: 4 * 60,
      clock: { kind: "Paused", pausedAt: at(3) },
    });
  });

  test("再開すると止めたところから進み、切り替わり時刻が一時停止した分だけ後ろにずれる", () => {
    const events = [
      ...start,
      { kind: "Pause", at: at(3) },
      { kind: "Resume", at: at(10) },
    ] as const satisfies SessionEvents;

    expect(derive(events, at(10))).toMatchObject({
      kind: "Focus",
      remainingSeconds: 4 * 60,
      clock: { kind: "Running", endsAt: at(14) },
    });
    expect(derive(events, at(14))).toMatchObject({ kind: "Journal", setNumber: 1 });
  });

  test("一時停止しても完了セットかどうかに影響しない", () => {
    const events = [
      ...start,
      { kind: "Pause", at: at(3) },
      { kind: "Resume", at: at(10) },
    ] as const satisfies SessionEvents;

    expect(derive(events, at(14))).toMatchObject({ kind: "Journal", completedSets: 1 });
  });

  test("ジャーナル中も一時停止できる", () => {
    const events = [...start, { kind: "Pause", at: at(7, 30) }] as const satisfies SessionEvents;

    expect(derive(events, at(30))).toMatchObject({
      kind: "Journal",
      setNumber: 1,
      remainingSeconds: 30,
      clock: { kind: "Paused", pausedAt: at(7, 30) },
    });
  });

  test("休憩中も一時停止でき、再開すると休憩の続きから進む", () => {
    const events = [
      ...start,
      { kind: "Pause", at: at(25) },
      { kind: "Resume", at: at(40) },
    ] as const satisfies SessionEvents;

    expect(derive(events, at(39))).toMatchObject({
      kind: "Break",
      remainingSeconds: 4 * 60,
      clock: { kind: "Paused", pausedAt: at(25) },
    });
    expect(derive(events, at(44))).toMatchObject({ kind: "Focus", round: 2, setNumber: 1 });
  });

  test("待機中は一時停止できない", () => {
    const events = [
      ...start,
      { kind: "Abort", at: at(3) },
      { kind: "Pause", at: at(4) },
    ] as const satisfies SessionEvents;

    expect(reject(events, at(5))).toEqual({
      kind: "OperationRejected",
      operation: "Pause",
      at: at(4),
      during: "Idle",
    });
  });

  test("一時停止していなければ再開できない", () => {
    const events = [...start, { kind: "Resume", at: at(3) }] as const satisfies SessionEvents;

    expect(reject(events, at(5))).toMatchObject({ operation: "Resume", during: "Focus" });
  });
});

describe("中断", () => {
  test("集中中に中断すると不成立セットになり待機に戻る", () => {
    const events = [...start, { kind: "Abort", at: at(3) }] as const satisfies SessionEvents;

    expect(derive(events, at(30))).toEqual({
      kind: "Idle",
      round: 1,
      setNumber: 1,
      completedSets: 0,
    });
  });

  test("中断した後の集中の再開始は、同じセット番号でやり直しになる", () => {
    const events = [
      ...start,
      { kind: "Abort", at: at(10) },
      { kind: "RestartFocus", at: at(12) },
    ] as const satisfies SessionEvents;

    // 1セット目は完了し、2セット目の集中を3分目に中断した
    expect(derive(events, at(12))).toEqual({
      kind: "Focus",
      round: 1,
      setNumber: 2,
      completedSets: 1,
      remainingSeconds: 7 * 60,
      clock: { kind: "Running", endsAt: at(19) },
    });
  });

  test("不成立セットはラウンド内のセット数に数えないので、休憩までのセットが1つ増える", () => {
    const events = [
      ...start,
      { kind: "Abort", at: at(3) },
      { kind: "RestartFocus", at: at(5) },
    ] as const satisfies SessionEvents;

    // やり直した1セット目から3セット終えるのは 5 + 24 = 29分
    expect(derive(events, at(28))).toMatchObject({ kind: "Journal", setNumber: 3 });
    expect(derive(events, at(29))).toMatchObject({ kind: "Break", round: 1, completedSets: 3 });
  });

  test("一時停止中の集中も中断できる", () => {
    const events = [
      ...start,
      { kind: "Pause", at: at(3) },
      { kind: "Abort", at: at(4) },
    ] as const satisfies SessionEvents;

    expect(derive(events, at(5))).toMatchObject({ kind: "Idle", setNumber: 1, completedSets: 0 });
  });

  test("ジャーナル中は中断できない", () => {
    const events = [...start, { kind: "Abort", at: at(7, 30) }] as const satisfies SessionEvents;

    expect(reject(events, at(8))).toMatchObject({ operation: "Abort", during: "Journal" });
  });

  test("休憩中は中断できない", () => {
    const events = [...start, { kind: "Abort", at: at(25) }] as const satisfies SessionEvents;

    expect(reject(events, at(26))).toMatchObject({ operation: "Abort", during: "Break" });
  });

  test("待機中でなければ集中の再開始はできない", () => {
    const events = [...start, { kind: "RestartFocus", at: at(3) }] as const satisfies SessionEvents;

    expect(reject(events, at(4))).toMatchObject({ operation: "RestartFocus", during: "Focus" });
  });
});

describe("終了", () => {
  test("集中中に終了したセットは不成立セットになる", () => {
    const events = [...start, { kind: "End", at: at(10) }] as const satisfies SessionEvents;

    expect(derive(events, at(30))).toEqual({
      kind: "Ended",
      endedAt: at(10),
      endedBy: "End",
      completedSets: 1,
    });
  });

  test("ジャーナル中に終了したセットは完了セットのまま", () => {
    const events = [...start, { kind: "End", at: at(7, 30) }] as const satisfies SessionEvents;

    expect(derive(events, at(30))).toMatchObject({ kind: "Ended", completedSets: 1 });
  });

  test("休憩中に終了しても完了セットのまま", () => {
    const events = [...start, { kind: "End", at: at(26) }] as const satisfies SessionEvents;

    expect(derive(events, at(30))).toMatchObject({ kind: "Ended", completedSets: 3 });
  });

  test("一時停止中の集中で終了したセットも不成立セットになる", () => {
    const events = [
      ...start,
      { kind: "Pause", at: at(3) },
      { kind: "End", at: at(20) },
    ] as const satisfies SessionEvents;

    expect(derive(events, at(30))).toMatchObject({ kind: "Ended", completedSets: 0 });
  });

  test("待機中も終了できる", () => {
    const events = [
      ...start,
      { kind: "Abort", at: at(3) },
      { kind: "End", at: at(4) },
    ] as const satisfies SessionEvents;

    expect(derive(events, at(5))).toMatchObject({ kind: "Ended", endedAt: at(4) });
  });

  test("終了した後は操作できない", () => {
    const events = [
      ...start,
      { kind: "End", at: at(3) },
      { kind: "RestartFocus", at: at(4) },
    ] as const satisfies SessionEvents;

    expect(reject(events, at(5))).toMatchObject({ operation: "RestartFocus", during: "Ended" });
  });
});

describe("休憩スキップ", () => {
  test("休憩スキップで次のラウンドの集中がすぐ始まる", () => {
    const events = [...start, { kind: "SkipBreak", at: at(25) }] as const satisfies SessionEvents;

    expect(derive(events, at(25))).toEqual({
      kind: "Focus",
      round: 2,
      setNumber: 1,
      completedSets: 3,
      remainingSeconds: 7 * 60,
      clock: { kind: "Running", endsAt: at(32) },
    });
  });

  test("一時停止中の休憩もスキップできる", () => {
    const events = [
      ...start,
      { kind: "Pause", at: at(25) },
      { kind: "SkipBreak", at: at(40) },
    ] as const satisfies SessionEvents;

    expect(derive(events, at(40))).toMatchObject({
      kind: "Focus",
      round: 2,
      clock: { kind: "Running", endsAt: at(47) },
    });
  });

  test("休憩中でなければスキップできない", () => {
    const events = [...start, { kind: "SkipBreak", at: at(3) }] as const satisfies SessionEvents;

    expect(reject(events, at(4))).toMatchObject({ operation: "SkipBreak", during: "Focus" });
  });
});

describe("自動終了", () => {
  test("記入も操作もないまま2ラウンド分（58分）過ぎると、最後の操作の時刻で閉じ、それ以降のセットは数えない", () => {
    expect(derive(start, at(58))).toEqual({
      kind: "Ended",
      endedAt: at(0),
      endedBy: "AutoEnd",
      completedSets: 0,
    });
  });

  test("2ラウンド分に満たなければ自動終了しない", () => {
    expect(derive(start, new Date(at(58).getTime() - 1))).toMatchObject({
      kind: "Break",
      round: 2,
      completedSets: 6,
    });
  });

  test("ジャーナル記入があれば、最後の記入の時刻で閉じ、そこまでの完了セットを数える", () => {
    const journalEntryTimes = [at(7, 30), at(15, 30)];

    expect(derive(start, at(73), journalEntryTimes)).toMatchObject({ kind: "Journal", round: 3 });
    expect(derive(start, at(73, 30), journalEntryTimes)).toEqual({
      kind: "Ended",
      endedAt: at(15, 30),
      endedBy: "AutoEnd",
      completedSets: 2,
    });
  });

  test("最後の操作が集中の途中なら、そのセットは不成立セットになる", () => {
    const events = [...start, { kind: "Pause", at: at(10) }] as const satisfies SessionEvents;

    expect(derive(events, at(68))).toEqual({
      kind: "Ended",
      endedAt: at(10),
      endedBy: "AutoEnd",
      completedSets: 1,
    });
  });

  test("一時停止したまま2ラウンド分過ぎても自動終了する", () => {
    const events = [...start, { kind: "Pause", at: at(7, 30) }] as const satisfies SessionEvents;

    expect(derive(events, at(65, 30))).toMatchObject({
      kind: "Ended",
      endedAt: at(7, 30),
      endedBy: "AutoEnd",
      completedSets: 1,
    });
  });

  test("待機のまま2ラウンド分過ぎても自動終了する", () => {
    const events = [...start, { kind: "Abort", at: at(3) }] as const satisfies SessionEvents;

    expect(derive(events, at(61))).toMatchObject({ kind: "Ended", endedAt: at(3) });
  });

  test("自動終了した時刻より後の操作は受け付けない", () => {
    const events = [...start, { kind: "Pause", at: at(60) }] as const satisfies SessionEvents;

    expect(reject(events, at(61))).toMatchObject({ operation: "Pause", during: "Ended" });
  });

  test("手動で終了したセッションは自動終了に書き換わらない", () => {
    const events = [...start, { kind: "End", at: at(10) }] as const satisfies SessionEvents;

    expect(derive(events, at(200))).toMatchObject({ endedAt: at(10), endedBy: "End" });
  });
});

describe("操作イベントの並び", () => {
  test("指定した時刻より後の操作イベントはまだ起きていないものとして扱う", () => {
    const events = [...start, { kind: "Pause", at: at(5) }] as const satisfies SessionEvents;

    expect(derive(events, at(4))).toMatchObject({
      kind: "Focus",
      clock: { kind: "Running", endsAt: at(7) },
    });
  });

  test("操作イベントが時刻の順に並んでいなければ失敗する", () => {
    const events = [
      ...start,
      { kind: "Pause", at: at(5) },
      { kind: "Resume", at: at(4) },
    ] as const satisfies SessionEvents;

    expect(reject(events, at(6))).toEqual({ kind: "EventOutOfOrder", at: at(4) });
  });
});

describe("完了セットになった時刻", () => {
  const completedSetTimes = (
    events: SessionEvents,
    now: Date,
    journalEntryTimes: ReadonlyArray<Date> = [],
  ) => {
    const derived = deriveCompletedSetTimes(events, now, journalEntryTimes);
    if (Result.isFailure(derived)) {
      throw new Error(`完了セットを計算できなかった: ${derived.error.kind}`);
    }
    return derived.value;
  };

  test("完了セットは集中を最後まで終えた時刻に数え、ジャーナルの終わりではない", () => {
    expect(completedSetTimes(start, at(16))).toEqual([at(7), at(15)]);
  });

  test("一時停止した分だけ、集中を終えた時刻が後ろにずれる", () => {
    const events = [
      ...start,
      { kind: "Pause", at: at(2) },
      { kind: "Resume", at: at(5) },
    ] as const satisfies SessionEvents;

    expect(completedSetTimes(events, at(11))).toEqual([at(10)]);
  });

  test("中断した不成立セットは数えない", () => {
    const events = [...start, { kind: "Abort", at: at(3) }] as const satisfies SessionEvents;

    expect(completedSetTimes(events, at(20))).toEqual([]);
  });

  test("自動終了したら、最後の操作より後に終わるはずだったセットは数えない", () => {
    expect(completedSetTimes(start, at(120))).toEqual([]);
  });

  test("数はタイマーの状態の完了セット数と一致する", () => {
    const events = [
      ...start,
      { kind: "Pause", at: at(20) },
      { kind: "Resume", at: at(21) },
    ] as const satisfies SessionEvents;

    expect(completedSetTimes(events, at(40))).toHaveLength(derive(events, at(40)).completedSets);
  });
});

describe("セットの結末", () => {
  const setOutcomes = (
    events: SessionEvents,
    now: Date,
    journalEntryTimes: ReadonlyArray<Date> = [],
  ) => {
    const derived = deriveSetOutcomes(events, now, journalEntryTimes);
    if (Result.isFailure(derived)) {
      throw new Error(`セットの結末を計算できなかった: ${derived.error.kind}`);
    }
    return derived.value;
  };

  test("集中を最後まで終えたセットは、集中を終えた時刻の完了セットになる", () => {
    expect(setOutcomes(start, at(16))).toEqual([
      { kind: "CompletedSet", round: 1, setNumber: 1, at: at(7) },
      { kind: "CompletedSet", round: 1, setNumber: 2, at: at(15) },
    ]);
  });

  test("集中中に中断すると不成立セットになり、集中を再開始すると同じセット番号でやり直す", () => {
    const events = [
      ...start,
      { kind: "Abort", at: at(3) },
      { kind: "RestartFocus", at: at(5) },
    ] as const satisfies SessionEvents;

    expect(setOutcomes(events, at(13))).toEqual([
      { kind: "AbortedSet", round: 1, setNumber: 1, at: at(3) },
      { kind: "CompletedSet", round: 1, setNumber: 1, at: at(12) },
    ]);
  });

  test("一時停止中の集中を中断しても不成立セットになる", () => {
    const events = [
      ...start,
      { kind: "Pause", at: at(2) },
      { kind: "Abort", at: at(4) },
    ] as const satisfies SessionEvents;

    expect(setOutcomes(events, at(5))).toEqual([
      { kind: "AbortedSet", round: 1, setNumber: 1, at: at(4) },
    ]);
  });

  test("集中の途中で終了したセットは不成立セットになる", () => {
    const events = [...start, { kind: "End", at: at(10) }] as const satisfies SessionEvents;

    expect(setOutcomes(events, at(11))).toEqual([
      { kind: "CompletedSet", round: 1, setNumber: 1, at: at(7) },
      { kind: "AbortedSet", round: 1, setNumber: 2, at: at(10) },
    ]);
  });

  test("ジャーナル中・休憩中・待機中に終了しても、不成立セットは増えない", () => {
    const duringJournal = [
      ...start,
      { kind: "End", at: at(7, 30) },
    ] as const satisfies SessionEvents;
    const duringIdle = [
      ...start,
      { kind: "Abort", at: at(3) },
      { kind: "End", at: at(4) },
    ] as const satisfies SessionEvents;

    expect(setOutcomes(duringJournal, at(8))).toEqual([
      { kind: "CompletedSet", round: 1, setNumber: 1, at: at(7) },
    ]);
    expect(setOutcomes(duringIdle, at(5))).toEqual([
      { kind: "AbortedSet", round: 1, setNumber: 1, at: at(3) },
    ]);
  });

  test("自動終了した時刻が集中の途中なら、そのセットは不成立セットになる", () => {
    // 最後の操作（開始）の時刻で閉じるので、1セット目の集中の途中で終了したのと同じ
    expect(setOutcomes(start, at(120))).toEqual([
      { kind: "AbortedSet", round: 1, setNumber: 1, at: at(0) },
    ]);
  });

  test("完了セットの数はタイマーの状態の完了セット数と一致する", () => {
    const events = [
      ...start,
      { kind: "Abort", at: at(10) },
      { kind: "RestartFocus", at: at(11) },
    ] as const satisfies SessionEvents;

    expect(setOutcomes(events, at(40)).filter((set) => set.kind === "CompletedSet")).toHaveLength(
      derive(events, at(40)).completedSets,
    );
  });
});
