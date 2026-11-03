import { describe, expect, test } from "vite-plus/test";
import { canonicalRedirectFor, resolveBaseURL } from "./base-url.ts";

describe("認証を受け付けるホスト（resolveBaseURL）", () => {
  test("本番の nanaichi.app では、そのオリジンを baseURL にする", () => {
    expect(resolveBaseURL("https://nanaichi.app/api/auth/get-session")).toBe(
      "https://nanaichi.app",
    );
  });

  test("ローカルの開発サーバーと portless の *.localhost では受け付ける", () => {
    expect(resolveBaseURL("http://localhost:5173/api/me")).toBe("http://localhost:5173");
    expect(resolveBaseURL("https://fix-ui.nanaichi.localhost/api/me")).toBe(
      "https://fix-ui.nanaichi.localhost",
    );
  });

  test.each([
    ["転送元の workers.dev", "https://nanaichi.onori-black1984.workers.dev/api/auth/get-session"],
    [
      "workers.dev のプレビューの URL",
      "https://abc123-nanaichi.onori-black1984.workers.dev/api/me",
    ],
    ["nanaichi.app のサブドメイン", "https://www.nanaichi.app/api/me"],
    ["nanaichi.app を名前に含む別のドメイン", "https://nanaichi.app.evil.test/api/me"],
  ])("%s では受け付けない", (_, url) => {
    expect(() => resolveBaseURL(url)).toThrow();
  });
});

describe("正のオリジンへの転送（canonicalRedirectFor）", () => {
  test("workers.dev へのリクエストは nanaichi.app の同じパスとクエリへ転送する", () => {
    expect(
      canonicalRedirectFor("https://nanaichi.onori-black1984.workers.dev/lp?utm_source=slack#top"),
    ).toBe("https://nanaichi.app/lp?utm_source=slack");
  });

  test("workers.dev のプレビューの URL も転送する", () => {
    expect(canonicalRedirectFor("https://abc123-nanaichi.onori-black1984.workers.dev/")).toBe(
      "https://nanaichi.app/",
    );
  });

  test.each([
    ["nanaichi.app", "https://nanaichi.app/lp"],
    ["ローカルの開発サーバー", "http://localhost:5173/"],
    ["portless の *.localhost", "https://fix-ui.nanaichi.localhost/"],
  ])("%s へのリクエストは転送しない", (_, url) => {
    expect(canonicalRedirectFor(url)).toBeUndefined();
  });
});
