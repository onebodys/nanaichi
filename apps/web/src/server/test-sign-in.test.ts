import { afterEach, describe, expect, test } from "vite-plus/test";
import { type AuthHarness, startAuthHarness } from "./auth-test-harness.ts";

let harness: AuthHarness;

afterEach(async () => {
  await harness.dispose();
});

const signInPath = (email: string) => `/api/test/sign-in?email=${encodeURIComponent(email)}`;

/** `Set-Cookie` を、次のリクエストに載せる `cookie` ヘッダにする */
const cookieFrom = (res: Response): Headers =>
  new Headers({
    cookie: res.headers
      .getSetCookie()
      .map((setCookie) => setCookie.split(";")[0])
      .join("; "),
  });

const PRODUCTION_ORIGIN = "https://nanaichi.onori-black1984.workers.dev";

describe("テスト用のログインが有効なとき（ローカルの開発サーバーと E2E）", () => {
  test("許可リストのメールアドレスでログインしてホームへ戻り、そのまま認証が必要な API を使える", async () => {
    harness = await startAuthHarness("me@example.com", { TEST_SIGN_IN: "enabled" });

    const res = await harness.request(signInPath("me@example.com"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const me = await harness.request("/api/me", { headers: cookieFrom(res) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { email: "me@example.com" } });
  });

  test("2回ログインしても同じユーザーになる", async () => {
    harness = await startAuthHarness("me@example.com", { TEST_SIGN_IN: "enabled" });

    const idOf = async () => {
      const res = await harness.request(signInPath("me@example.com"));
      const me = await harness.request("/api/me", { headers: cookieFrom(res) });
      return (await me.json<{ user: { id: string } }>()).user.id;
    };

    expect(await idOf()).toBe(await idOf());
  });

  test("許可リストに載っていないメールアドレスではログインさせず 403 を返す", async () => {
    harness = await startAuthHarness("me@example.com", { TEST_SIGN_IN: "enabled" });

    const res = await harness.request(signInPath("someone-else@example.com"));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "EMAIL_NOT_ALLOWED" });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("メールアドレスがなければ 400 を返し、どの項目が不正かだけを示す", async () => {
    harness = await startAuthHarness("me@example.com", { TEST_SIGN_IN: "enabled" });

    const res = await harness.request("/api/test/sign-in");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST", paths: ["email"] });
  });
});

describe("本番ではテスト用のログインを使えない", () => {
  test("本番のバインディング（TEST_SIGN_IN なし）では経路がなく 404 を返し、ログインさせない", async () => {
    harness = await startAuthHarness("me@example.com");

    const res = await harness.request(signInPath("me@example.com"));

    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("TEST_SIGN_IN が enabled 以外の値なら 404 を返す", async () => {
    harness = await startAuthHarness("me@example.com", { TEST_SIGN_IN: "true" });

    const res = await harness.request(signInPath("me@example.com"));

    expect(res.status).toBe(404);
  });

  test("誤って本番に TEST_SIGN_IN を登録しても、本番のホストでは 404 を返す", async () => {
    harness = await startAuthHarness("me@example.com", { TEST_SIGN_IN: "enabled" });

    const res = await harness.requestFrom(PRODUCTION_ORIGIN, signInPath("me@example.com"));

    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
