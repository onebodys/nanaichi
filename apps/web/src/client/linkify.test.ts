import { describe, expect, test } from "vite-plus/test";
import { linkify } from "./linkify.ts";

describe("記入の本文の URL の自動リンク", () => {
  test("URL のない本文は、そのままのテキスト1つ", () => {
    expect(linkify("設計を書いた\n次はテスト")).toEqual([
      { kind: "Text", text: "設計を書いた\n次はテスト" },
    ]);
  });

  test("http と https の URL だけをリンクにし、前後はテキストのまま", () => {
    expect(linkify("参考 https://example.com/a?b=1#c と http://example.org")).toEqual([
      { kind: "Text", text: "参考 " },
      { kind: "Link", href: "https://example.com/a?b=1#c" },
      { kind: "Text", text: " と " },
      { kind: "Link", href: "http://example.org" },
    ]);
  });

  test("URL の末尾の句読点や閉じかっこは URL に含めない", () => {
    expect(linkify("(https://example.com/x). 次へ")).toEqual([
      { kind: "Text", text: "(" },
      { kind: "Link", href: "https://example.com/x" },
      { kind: "Text", text: "). 次へ" },
    ]);
  });

  test("日本語の句読点で URL が終わる", () => {
    expect(linkify("https://example.com/日本語、を見た")).toEqual([
      { kind: "Link", href: "https://example.com/日本語" },
      { kind: "Text", text: "、を見た" },
    ]);
  });

  test("javascript: などの URL や記法はリンクにしない", () => {
    expect(linkify("javascript:alert(1) [x](https)")).toEqual([
      { kind: "Text", text: "javascript:alert(1) [x](https)" },
    ]);
  });
});
