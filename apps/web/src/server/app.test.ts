import { describe, expect, test } from "vite-plus/test";
import { app } from "./app.ts";

/**
 * テスト用のバインディング。
 *
 * `DB`（D1）と `USER_DO` をあえて入れていない。未ログインのリクエストは
 * セッションを引く前に弾かれるのでデータベースに触れないはずで、もし触れば
 * `undefined` への参照でテストが落ちる。Hono の `request()` は第3引数に
 * 部分的な env を渡せるため、型を偽らずにこれを表現できる。
 */
const unauthenticatedEnv = {
  BETTER_AUTH_SECRET: "test-secret-value-that-is-long-enough",
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  ALLOWED_EMAILS: "me@example.com",
} satisfies Partial<Env>;

/**
 * Better Auth はリクエストの Host から baseURL を決めるため、開発サーバーと同じ
 * 許可済みのホストでリクエストする。`localhost`（ポートなし）は許可していない。
 */
const request = (path: string) =>
  app.request(`http://localhost:5173${path}`, undefined, unauthenticatedEnv);

describe("GET /api/health", () => {
  test("Worker が起動していれば status: ok を返す", async () => {
    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("ログインしていなくても応答する", async () => {
    const res = await request("/api/health");

    expect(res.status).toBe(200);
  });
});

describe("認証が必要な /api/*", () => {
  test("ログインしていなければ 401 を返す", async () => {
    const res = await request("/api/me");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  test("知らないパスでもログインしていなければ 401 を返す", async () => {
    const res = await request("/api/sessions");

    expect(res.status).toBe(401);
  });
});

describe("ログインの入口", () => {
  test("/api/auth/* は認証なしで通る（401 で塞がれない）", async () => {
    const res = await request("/api/auth/get-session");

    // セッションが無いので本文は null。認証を要求する 401 ではないことが要点。
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test("許可していないホストからのログインは受け付けない", async () => {
    const res = await app.request(
      "http://evil.test/api/auth/get-session",
      undefined,
      unauthenticatedEnv,
    );

    expect(res.status).toBe(400);
  });

  test("本番の nanaichi.app のホストは受け付ける", async () => {
    const res = await app.request(
      "https://nanaichi.app/api/auth/get-session",
      undefined,
      unauthenticatedEnv,
    );

    expect(res.status).toBe(200);
  });

  test("portless が worktree ごとに割り振る *.localhost のホストは受け付ける", async () => {
    const res = await app.request(
      "https://fix-ui.nanaichi.localhost/api/auth/get-session",
      undefined,
      unauthenticatedEnv,
    );

    expect(res.status).toBe(200);
  });

  test("localhost で終わっていても .localhost の下でないホストは受け付けない", async () => {
    const res = await app.request(
      "https://nanaichi.localhost.evil.test/api/auth/get-session",
      undefined,
      unauthenticatedEnv,
    );

    expect(res.status).toBe(400);
  });
});
