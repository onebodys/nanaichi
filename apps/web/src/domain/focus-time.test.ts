import { describe, expect, test } from "vite-plus/test";
import { FocusTime } from "./focus-time.ts";

describe("集中時間", () => {
  test("完了セット1つにつき集中の長さ（7分）を数える", () => {
    expect(FocusTime.ofCompletedSets(10)).toBe(70 * 60_000);
  });

  test("完了セットがなければ集中時間は0", () => {
    expect(FocusTime.ofCompletedSets(0)).toBe(0);
  });
});
