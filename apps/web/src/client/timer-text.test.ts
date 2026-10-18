import { describe, expect, test } from "vite-plus/test";
import { roundProgressOf } from "../domain/round-progress.ts";
import { timeLabelOf } from "./journal-text.ts";
import {
  abortedSetsNoteOf,
  countdownPartsOf,
  currentSessionLabelOf,
  endedMessageOf,
  pausedForLabelOf,
  sessionSpanLabelOf,
  idleMessageOf,
  sessionRhythmOf,
  untilBreakLabelOf,
  upcomingLabelOf,
} from "./timer-text.ts";

describe("カウントダウンの表示", () => {
  test.each([
    [7 * 60, "7", "00"],
    [3 * 60 + 40, "3", "40"],
    [59, "0", "59"],
    [5, "0", "05"],
    [0, "0", "00"],
  ])("残り %i 秒は %s:%s と表示する", (remainingSeconds, minutes, seconds) => {
    expect(countdownPartsOf(remainingSeconds)).toEqual({ minutes, seconds });
  });
});

describe("次に移るフェーズの表示", () => {
  test("集中中はジャーナルの長さを添える", () => {
    expect(upcomingLabelOf({ kind: "Journal", round: 2, setNumber: 2 })).toBe(
      "次は ジャーナル 1分",
    );
  });

  test("ジャーナル中は同じラウンドの次のセットの集中", () => {
    expect(upcomingLabelOf({ kind: "Focus", round: 2, setNumber: 3 })).toBe(
      "次は 集中（3セット目）",
    );
  });

  test("3セット目のジャーナル中は休憩の長さを添える", () => {
    expect(upcomingLabelOf({ kind: "Break", round: 1 })).toBe("次は 休憩 5分");
  });

  test("休憩中は次のラウンドの集中", () => {
    expect(upcomingLabelOf({ kind: "Focus", round: 3, setNumber: 1 })).toBe(
      "次は 3ラウンド目の集中",
    );
  });
});

describe("休憩まであと何セットかの表示", () => {
  test("1セット目の集中中は、休憩まであと3セット", () => {
    const progress = roundProgressOf({
      kind: "Focus",
      round: 1,
      setNumber: 1,
      completedSets: 0,
      remainingSeconds: 400,
      clock: { kind: "Running", endsAt: new Date(0) },
    });
    expect(untilBreakLabelOf(progress)).toBe("休憩まで あと3セット");
  });

  test("休憩中は出さない", () => {
    const progress = roundProgressOf({
      kind: "Break",
      round: 1,
      completedSets: 3,
      remainingSeconds: 100,
      clock: { kind: "Running", endsAt: new Date(0) },
    });
    expect(untilBreakLabelOf(progress)).toBeUndefined();
  });
});

test("開始前は、1セットの流れとラウンドごとの休憩を説明する", () => {
  expect(sessionRhythmOf()).toEqual({
    focusSeconds: 7 * 60,
    set: "集中 7分 → ジャーナル 1分",
    round: "3セットごとに 5分の休憩が入ります",
  });
});

test("中断のあとの待機では、中断したセットを集中の再開始ではじめからやり直せると説明する", () => {
  expect(idleMessageOf(2)).toEqual({
    title: "2セット目を中断しました",
    body: "集中を再開始すると、2セット目の集中をはじめからやり直します",
  });
});

describe("セッションの積み上げとまとめの表示", () => {
  const startedAt = new Date(Date.UTC(2026, 9, 17, 4, 5, 0));
  const later = (seconds: number) => new Date(startedAt.getTime() + seconds * 1000);

  test("セッション中は、始めた時刻とこのセッションの完了セット・集中時間を出す", () => {
    expect(currentSessionLabelOf(startedAt, 4)).toBe(
      `このセッション ${timeLabelOf(startedAt)}〜 · 完了 4セット · 集中 28分`,
    );
  });

  test("一時停止中は止めてからの時間を出し、1分未満は秒だけにする", () => {
    expect(pausedForLabelOf(startedAt, later(133))).toBe("止めてから 2分13秒");
    expect(pausedForLabelOf(startedAt, later(13))).toBe("止めてから 13秒");
    expect(pausedForLabelOf(startedAt, later(60))).toBe("止めてから 1分00秒");
  });

  test("セッションのまとめには、始めた時刻と終わった時刻を出す", () => {
    expect(sessionSpanLabelOf(startedAt, later(117 * 60))).toBe(
      `${timeLabelOf(startedAt)} 〜 ${timeLabelOf(later(117 * 60))}`,
    );
  });

  test("不成立セットがあるときだけ、点線の意味を説明する", () => {
    expect(abortedSetsNoteOf(2)).toBe("点線は不成立セット（2セット）");
    expect(abortedSetsNoteOf(0)).toBeUndefined();
  });

  test("自動終了したときは、記入も操作もないまま時間が過ぎたことを伝える", () => {
    expect(endedMessageOf("End")).toBe("セッションを終了しました");
    expect(endedMessageOf("AutoEnd")).toBe(
      "記入も操作もないまま時間が過ぎたので、セッションを自動終了しました",
    );
  });
});
