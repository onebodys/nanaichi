import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { type AuthHarness, startAuthHarness } from "./auth-test-harness.ts";

let harness: AuthHarness;

beforeEach(async () => {
  harness = await startAuthHarness("me@example.com");
});

afterEach(async () => {
  await harness.dispose();
});

describe("認証が必要な /api/*", () => {
  test("ログインしていなければ 401 を返す", async () => {
    const res = await harness.request("/api/me");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  test("許可リストに載っているユーザーでログインしていれば使える", async () => {
    const headers = await harness.signInAs("me@example.com");

    const res = await harness.request("/api/me", { headers });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { email: "me@example.com" } });
  });

  test("許可リストから外れたユーザーはログインしていても 403 を返す", async () => {
    const headers = await harness.signInAs("removed@example.com");

    const res = await harness.request("/api/me", { headers });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "EMAIL_NOT_ALLOWED" });
  });

  test("ログアウトしたセッションでは 401 を返す", async () => {
    const headers = await harness.signInAs("me@example.com");

    const signOut = await harness.request("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie: headers.get("cookie") ?? "", origin: "http://localhost:5173" },
    });
    expect(signOut.status).toBe(200);

    const res = await harness.request("/api/me", { headers });

    expect(res.status).toBe(401);
  });
});
