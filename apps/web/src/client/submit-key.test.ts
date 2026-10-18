import { describe, expect, test } from "vite-plus/test";
import {
  defaultSubmitKey,
  modifierLabelOf,
  shouldSubmit,
  submitKeyHintOf,
  submitKeyLabelOf,
} from "./submit-key.ts";

const press = (
  overrides: Partial<{
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    isComposing: boolean;
  }> = {},
) => ({
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  ...overrides,
});

describe("送信キー", () => {
  test("既定の送信キーは Enter で改行する方", () => {
    expect(defaultSubmitKey).toBe("ModifierEnter");
  });

  describe("Enter で改行する送信キー", () => {
    test("Enter だけでは送らず改行する", () => {
      expect(shouldSubmit("ModifierEnter", press())).toBe(false);
    });

    test("Shift+Enter でも送らず改行する", () => {
      expect(shouldSubmit("ModifierEnter", press({ shiftKey: true }))).toBe(false);
    });

    test("⌘+Enter で送る", () => {
      expect(shouldSubmit("ModifierEnter", press({ metaKey: true }))).toBe(true);
    });

    test("Ctrl+Enter で送る（Mac 以外）", () => {
      expect(shouldSubmit("ModifierEnter", press({ ctrlKey: true }))).toBe(true);
    });

    test("変換中の ⌘+Enter では送らない", () => {
      expect(shouldSubmit("ModifierEnter", press({ metaKey: true, isComposing: true }))).toBe(
        false,
      );
    });
  });

  describe("Enter で送る送信キー", () => {
    test("Enter で送る", () => {
      expect(shouldSubmit("Enter", press())).toBe(true);
    });

    test("Shift+Enter では送らず改行する", () => {
      expect(shouldSubmit("Enter", press({ shiftKey: true }))).toBe(false);
    });

    test("変換を確定する Enter では送らない", () => {
      expect(shouldSubmit("Enter", press({ isComposing: true }))).toBe(false);
    });
  });

  test("Enter 以外のキーではどちらの送信キーでも送らない", () => {
    expect(shouldSubmit("Enter", press({ key: "a" }))).toBe(false);
    expect(shouldSubmit("ModifierEnter", press({ key: "a", metaKey: true }))).toBe(false);
  });

  test.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "⌘"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "⌘"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Ctrl"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "Ctrl"],
  ])("修飾キーは Apple の端末なら ⌘、それ以外は Ctrl と出す: %s", (userAgent, label) => {
    expect(modifierLabelOf(userAgent)).toBe(label);
  });

  test("送信キーの選択肢と入力欄の案内に送り方を出す", () => {
    expect(submitKeyLabelOf("ModifierEnter", "⌘")).toBe("⌘+Enter で送信");
    expect(submitKeyLabelOf("Enter", "⌘")).toBe("Enter で送信");
    expect(submitKeyHintOf("ModifierEnter", "Ctrl")).toBe("Ctrl+Enter で送信、Enter で改行");
    expect(submitKeyHintOf("Enter", "Ctrl")).toBe("Enter で送信、Shift+Enter で改行");
  });
});
