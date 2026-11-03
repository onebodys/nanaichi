import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { prepareDatabase, request, resetStorage, signInAs } from "./workers-test-harness.ts";

/**
 * wrangler.jsonc のとおりに起動した Worker で、workers.dev へのリクエストが静的アセットを含めて
 * nanaichi.app へ転送されることを確かめる（ADR 0021）。`run_worker_first` を狭めて静的アセットが
 * Worker を通らなくなると、ここが落ちる。
 */

const WORKERS_DEV = "https://nanaichi.onori-black1984.workers.dev";

describe("workers.dev へのリクエスト", () => {
  test.each([
    ["アプリ", "/"],
    ["アプリの画面", "/history?date=2026-11-03"],
    ["LP", "/lp"],
    ["静的アセット", "/landing/og.png"],
    ["Service Worker", "/sw.js"],
    ["API", "/api/health"],
    ["OAuth の文書", "/.well-known/oauth-authorization-server"],
  ])("%s（%s）は nanaichi.app の同じパスとクエリへ 308 で転送する", async (_, path) => {
    const res = await request(path, { redirect: "manual" }, WORKERS_DEV);

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`https://nanaichi.app${path}`);
  });

  test("MCP クライアントの POST も 308 で転送し、ログインのセッションを作らない", async () => {
    const res = await request(
      "/api/mcp",
      { method: "POST", body: "{}", redirect: "manual" },
      WORKERS_DEV,
    );

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://nanaichi.app/api/mcp");
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("nanaichi.app へのリクエスト", () => {
  test("転送せずに API が答える", async () => {
    const res = await request("/api/health", undefined, "https://nanaichi.app");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("すべてのリクエストを Worker が先に受けるとき", () => {
  beforeEach(async () => {
    await prepareDatabase();
  });

  afterEach(async () => {
    await resetStorage();
  });

  // このテストの Worker には静的アセットのディレクトリがなく、ASSETS に渡ると 500 になる。404 なら Worker が答えている
  test("ログインしていても、知らない API は静的アセット（SPA の画面）に回さず 404 を返す", async () => {
    const { headers } = await signInAs("me@example.com");

    const res = await request("/api/unknown-endpoint", { headers });

    expect(res.status).toBe(404);
  });
});
