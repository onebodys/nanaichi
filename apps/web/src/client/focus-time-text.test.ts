import { describe, expect, test } from "vite-plus/test";
import {
  completedSetsAndFocusTimeOf,
  daySessionStatsOf,
  focusTimeLabelOf,
  focusTimeShortLabelOf,
  todayFocusOf,
} from "./focus-time-text.ts";

const minutes = (n: number) => n * 60_000;

describe("集中時間の表示", () => {
  test.each([
    [0, "0分"],
    [42, "42分"],
    [60, "1時間0分"],
    [70, "1時間10分"],
  ])("%i分の集中時間は「%s」", (n, label) => {
    expect(focusTimeLabelOf(minutes(n))).toBe(label);
  });

  test("スマホのヘッダーでは時間と分を「:」でつなぐ", () => {
    expect(focusTimeShortLabelOf(minutes(84))).toBe("1:24");
    expect(focusTimeShortLabelOf(minutes(7))).toBe("0:07");
  });

  test("完了セットの数に、その集中時間（1セット7分）を添える", () => {
    expect(completedSetsAndFocusTimeOf(10)).toBe("完了 10セット · 集中 1時間10分");
    expect(completedSetsAndFocusTimeOf(0)).toBe("完了 0セット · 集中 0分");
  });
});

test("セッションの区切りには、その日に完了したセットがあるときだけ積み上げを添える", () => {
  expect(daySessionStatsOf(6)).toBe("完了 6セット · 集中 42分");
  expect(daySessionStatsOf(0)).toBeUndefined();
});

describe("今日の集中時間", () => {
  test("今日の完了セット数から、集中時間とセット数を出す", () => {
    expect(todayFocusOf({ kind: "Counted", count: 12 })).toEqual({
      kind: "Counted",
      long: "1時間24分",
      short: "1:24",
      sets: "12セット",
    });
  });

  test("タイムラインを読み込むまで・完了セット数が確定するまでは数を出さない", () => {
    expect(todayFocusOf({ kind: "Loading" })).toEqual({ kind: "Unknown" });
    expect(todayFocusOf({ kind: "NotYetCounted" })).toEqual({ kind: "Unknown" });
  });
});
