import { afterEach, describe, expect, test } from "vite-plus/test";
import { type AuthHarness, startAuthHarness } from "./auth-test-harness.ts";

/**
 * 静的アセット（Workers Static Assets）の代わり。どのパスの HTML を引いたかを本文で返し、
 * 受け取った条件付きリクエストのヘッダーも見られるようにする
 */
const fakeAssets = {
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return new Response(`asset:${new URL(request.url).pathname}`, {
      headers: {
        "Content-Type": "text/html",
        "X-If-None-Match": request.headers.get("If-None-Match") ?? "",
      },
    });
  },
  connect: () => {
    throw new Error("テストでは使わない");
  },
} satisfies Fetcher;

let harness: AuthHarness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

const start = async () => {
  harness = await startAuthHarness("me@example.com", { ASSETS: fakeAssets });
  return harness;
};

describe("GET /", () => {
  test("ログインしていなければ LP を返す", async () => {
    const { request } = await start();

    const res = await request("/");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset:/landing");
  });

  test("ログインしていればタイマーの画面（SPA）を返す", async () => {
    const { request, signInAs } = await start();
    const headers = await signInAs("me@example.com");

    const res = await request("/", { headers });

    expect(await res.text()).toBe("asset:/");
  });

  test("設定画面やスタッツを重ねて開く URL でも、ログインしていればタイマーの画面を返す", async () => {
    const { request, signInAs } = await start();
    const headers = await signInAs("me@example.com");

    const res = await request("/?stats=Week", { headers });

    expect(await res.text()).toBe("asset:/");
  });

  test("cookie で中身が変わることをキャッシュに伝える", async () => {
    const { request } = await start();

    const res = await request("/");

    expect(res.headers.get("Vary")).toContain("Cookie");
  });

  test("条件付きリクエストのヘッダーをアセットへそのまま渡す", async () => {
    const { request } = await start();

    const res = await request("/", { headers: { "If-None-Match": '"abc"' } });

    expect(res.headers.get("X-If-None-Match")).toBe('"abc"');
  });
});
