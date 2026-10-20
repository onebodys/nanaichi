import { describe, expect, test } from "vite-plus/test";
import { redirectHostOf, scopeDescriptionsOf } from "./consent-text.ts";

describe("連携の許可で求められた範囲の説明", () => {
  test("記録の読み取りと、ログインし直さずに読み続けることを、求められた順に出す", () => {
    expect(scopeDescriptionsOf("journal:read offline_access")).toEqual([
      "ジャーナル記入（本文とタグ）・スタッツ・タグを読む",
      "ログインし直さずに読み続ける（最長30日）",
    ]);
  });

  test("知らない範囲は隠さず、名前のまま出す", () => {
    expect(scopeDescriptionsOf("journal:write")).toEqual(["不明な範囲（journal:write）"]);
  });

  test("範囲がなければ何も出さない", () => {
    expect(scopeDescriptionsOf(undefined)).toEqual([]);
    expect(scopeDescriptionsOf("")).toEqual([]);
  });
});

describe("許可したあとに戻る先", () => {
  test("http(s) ならホストとポートを出す", () => {
    expect(redirectHostOf("http://localhost:33418/callback")).toBe("localhost:33418");
    expect(redirectHostOf("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
  });

  test("アプリのスキームならスキームを出す", () => {
    expect(redirectHostOf("cursor://anysphere.cursor-mcp/oauth/callback")).toBe("cursor:");
  });

  test("戻る先がないか URL でなければ出さない", () => {
    expect(redirectHostOf(undefined)).toBeUndefined();
    expect(redirectHostOf("not a url")).toBeUndefined();
  });
});
