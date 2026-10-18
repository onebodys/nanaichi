import { describe, expect, test } from "vite-plus/test";
import { resolveTheme } from "./theme.ts";

describe("画面の明るさ", () => {
  test("端末に合わせる好みでは、端末がダークならダーク、そうでなければライトになる", () => {
    expect(resolveTheme("System", true)).toBe("Dark");
    expect(resolveTheme("System", false)).toBe("Light");
  });

  test("ライト・ダークを選んだら、端末の設定によらずその明るさになる", () => {
    expect(resolveTheme("Light", true)).toBe("Light");
    expect(resolveTheme("Dark", false)).toBe("Dark");
  });
});
