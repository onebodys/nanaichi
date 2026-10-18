import { describe, expect, test } from "vite-plus/test";
import { parseThemePreference, resolveTheme } from "./theme.ts";

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

describe("明るさの好みの読み込み", () => {
  test("選んだことのない端末では、端末の設定に合わせる", () => {
    expect(parseThemePreference(null)).toBe("System");
  });

  test("選んだライト・ダークを読み戻す", () => {
    expect(parseThemePreference("Light")).toBe("Light");
    expect(parseThemePreference("Dark")).toBe("Dark");
  });

  test("知らない値は端末の設定に合わせる", () => {
    expect(parseThemePreference("Sepia")).toBe("System");
  });
});
