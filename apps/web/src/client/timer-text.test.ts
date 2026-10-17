import { describe, expect, test } from "vite-plus/test";
import { formatCountdown } from "./timer-text.ts";

describe("カウントダウンの表示", () => {
  test.each([
    [7 * 60, "7:00"],
    [3 * 60 + 40, "3:40"],
    [59, "0:59"],
    [5, "0:05"],
    [0, "0:00"],
  ])("残り %i 秒は %s と表示する", (remainingSeconds, shown) => {
    expect(formatCountdown(remainingSeconds)).toBe(shown);
  });
});
