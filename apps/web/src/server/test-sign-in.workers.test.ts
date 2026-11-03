import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { prepareDatabase, request, resetStorage } from "./workers-test-harness.ts";

/**
 * このファイルの Worker は wrangler.jsonc のとおりに起動し、secret だけを
 * vitest.workers.config.ts が足す。つまり本番にデプロイされるのと同じバインディングで動く。
 * ここでテスト用のログインが開かないことを確かめれば、wrangler.jsonc に `TEST_SIGN_IN` を
 * 書き足してしまったときに気づける（ADR 0008）。
 */

beforeEach(async () => {
  await prepareDatabase();
});

afterEach(async () => {
  await resetStorage();
});

const signInPath = "/api/test/sign-in?email=me%40example.com";

describe("本番と同じ設定（wrangler.jsonc）で動く Worker", () => {
  test("テスト用のログインの経路がなく 404 を返し、ログインさせない", async () => {
    const res = await request(signInPath);

    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("本番のホストへのリクエストでも 404 を返す", async () => {
    const res = await request(signInPath, undefined, "https://nanaichi.app");

    expect(res.status).toBe(404);
  });
});
