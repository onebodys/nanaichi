import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import * as v from "valibot";
import { ApiErrorBodyJsonSchema } from "../domain/api-error.ts";
import { startAuthHarness, type AuthHarness } from "./auth-test-harness.ts";
import {
  bearer,
  exchangeCode,
  newPkce,
  returnFromGoogle,
  signInNatively,
  startNativeSignIn,
} from "./native-auth-test-flow.ts";

const NOW = Date.UTC(2030, 0, 1, 0, 0, 0);
const passTo = (ms: number) => vi.setSystemTime(ms);
const seconds = (s: number) => NOW + s * 1000;

let harness: AuthHarness;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  passTo(NOW);
  harness = await startAuthHarness("me@example.com");
});

afterEach(async () => {
  vi.useRealTimers();
  await harness.dispose();
});

const request = (path: string, init?: RequestInit) => harness.request(path, init);
const sessionCookieOf = async (email: string) =>
  (await harness.signInAs(email)).get("cookie") ?? "";
const signIn = (email = "me@example.com") =>
  signInNatively(request, harness.database, () => sessionCookieOf(email));
const start = (challenge: string) => startNativeSignIn(request, harness.database, challenge);

const errorOf = async (res: Response) => v.parse(ApiErrorBodyJsonSchema, await res.json()).error;

/** `start` からコードを受け取るまで。引き換えは呼ぶ側で行う */
const codeFor = async (email = "me@example.com") => {
  const pkce = await newPkce();
  const { cookie, callbackURL } = await start(pkce.challenge);
  const params = await returnFromGoogle(
    request,
    `${await sessionCookieOf(email)}; ${cookie}`,
    callbackURL,
  );
  return { ...pkce, code: params.get("code") ?? "" };
};

describe("ネイティブアプリのログインを始める", () => {
  test("S256 の code_challenge を付けて開くと、Google のログインへ送る", async () => {
    const { challenge } = await newPkce();

    const { response } = await start(challenge);

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "").host).toBe("accounts.google.com");
  });

  test("code_challenge_method が S256 でなければ 400 で、Google へは送らない", async () => {
    const { challenge } = await newPkce();

    const res = await request(
      `/api/native-auth/start?code_challenge=${challenge}&code_challenge_method=plain`,
    );

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("INVALID_REQUEST");
  });
});

describe("Google から戻ったらアプリにコードを渡す", () => {
  test("この流れの Google のログインを終えて戻ったら、アプリのカスタム URL スキームに使い捨てのコードだけを渡す", async () => {
    const { challenge } = await newPkce();
    const { cookie, callbackURL } = await start(challenge);

    const params = await returnFromGoogle(
      request,
      `${await sessionCookieOf("me@example.com")}; ${cookie}`,
      callbackURL,
    );

    expect([...params.keys()]).toEqual(["code"]);
  });

  test("start のあとに画面で別にログインしても、この流れの Google のログインから戻ったのでなければコードを渡さない", async () => {
    const { challenge } = await newPkce();
    const { cookie } = await start(challenge);
    // 画面のログインは callbackURL が `/` なので、Google から戻っても native-auth の callback には来ない。
    // スキームを横取りしたアプリがそのあとブラウザを callback へ送っても、この流れの印（flow）を持っていない
    const webSession = await sessionCookieOf("me@example.com");

    const params = await returnFromGoogle(request, `${webSession}; ${cookie}`);

    expect(params.get("error")).toBe("SIGN_IN_FAILED");
    expect(params.has("code")).toBe(false);
  });

  test("別の流れの印（flow）で戻っても、コードを渡さない", async () => {
    const { challenge } = await newPkce();
    const { cookie } = await start(challenge);
    const other = await start((await newPkce()).challenge);

    const params = await returnFromGoogle(
      request,
      `${await sessionCookieOf("me@example.com")}; ${cookie}`,
      other.callbackURL,
    );

    expect(params.get("error")).toBe("SIGN_IN_FAILED");
  });

  test("callback へ戻ったら、流れの cookie をブラウザから消す", async () => {
    const { challenge } = await newPkce();
    const { cookie, callbackURL } = await start(challenge);

    const res = await request(callbackURL, {
      headers: { cookie: `${await sessionCookieOf("me@example.com")}; ${cookie}` },
      redirect: "manual",
    });

    expect(res.headers.getSetCookie().join()).toMatch(/nanaichi_native_sign_in=;.*Max-Age=0/);
  });

  test("start を開いていないブラウザでは、ログイン済みでもコードを渡さない", async () => {
    const params = await returnFromGoogle(request, await sessionCookieOf("me@example.com"));

    expect(params.get("error")).toBe("SIGN_IN_FAILED");
    expect(params.has("code")).toBe(false);
  });

  test("start より前からある画面のセッションには、コードを渡さない", async () => {
    const webSession = await sessionCookieOf("me@example.com");
    passTo(seconds(1));
    const { challenge } = await newPkce();
    const { cookie, callbackURL } = await start(challenge);

    const params = await returnFromGoogle(request, `${webSession}; ${cookie}`, callbackURL);

    expect(params.get("error")).toBe("SIGN_IN_FAILED");
  });

  test("許可リストから外れたユーザーには、コードを渡さず EMAIL_NOT_ALLOWED を返す", async () => {
    const { challenge } = await newPkce();
    const { cookie, callbackURL } = await start(challenge);

    const params = await returnFromGoogle(
      request,
      `${await sessionCookieOf("outsider@example.com")}; ${cookie}`,
      callbackURL,
    );

    expect(params.get("error")).toBe("EMAIL_NOT_ALLOWED");
  });

  test("Google のログインで許可リストに断られたら、アプリに EMAIL_NOT_ALLOWED を返す", async () => {
    const { challenge } = await newPkce();
    const { cookie } = await start(challenge);

    const params = await returnFromGoogle(
      request,
      cookie,
      "/api/native-auth/callback?error=EMAIL_NOT_ALLOWED",
    );

    expect(params.get("error")).toBe("EMAIL_NOT_ALLOWED");
  });
});

describe("コードと Bearer トークンを引き換える", () => {
  test("コードと code_verifier を送るとトークンが返り、そのトークンで API を呼べる", async () => {
    const token = await signIn();

    const res = await request("/api/me", { headers: bearer(token) });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { email: "me@example.com" } });
  });

  test("code_verifier が違えば引き換えられず、そのコードは正しい code_verifier でももう使えない", async () => {
    const { code, verifier } = await codeFor();
    const other = await newPkce();

    const wrong = await exchangeCode(request, code, other.verifier);
    const retried = await exchangeCode(request, code, verifier);

    expect(wrong.status).toBe(400);
    expect(await errorOf(wrong)).toBe("INVALID_GRANT");
    expect(await errorOf(retried)).toBe("INVALID_GRANT");
  });

  test("引き換えたコードは、もう一度は引き換えられない", async () => {
    const { code, verifier } = await codeFor();
    await exchangeCode(request, code, verifier);

    const reused = await exchangeCode(request, code, verifier);

    expect(reused.status).toBe(400);
    expect(await errorOf(reused)).toBe("INVALID_GRANT");
  });

  test("発行から 60 秒を過ぎたコードは引き換えられない", async () => {
    const { code, verifier } = await codeFor();
    passTo(seconds(61));

    const res = await exchangeCode(request, code, verifier);

    expect(await errorOf(res)).toBe("INVALID_GRANT");
  });

  test("知らないコードは引き換えられない", async () => {
    const { verifier } = await newPkce();

    const res = await exchangeCode(request, "unknown-code", verifier);

    expect(await errorOf(res)).toBe("INVALID_GRANT");
  });
});

describe("Bearer トークンでの認証", () => {
  test("トークンがなければ 401 を返す", async () => {
    const res = await request("/api/me");

    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe("UNAUTHENTICATED");
  });

  test("start の cookie の値（サーバーが署名した文字列）を Bearer トークンにしても 401 を返す", async () => {
    const { response } = await start((await newPkce()).challenge);
    const flowCookie = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("nanaichi_native_sign_in="));
    const value = decodeURIComponent(flowCookie?.split(";")[0]?.split("=")[1] ?? "");

    const res = await request("/api/me", { headers: bearer(value) });

    expect(value).toContain(".");
    expect(res.status).toBe(401);
  });

  test("署名を外したトークンは受け付けず 401 を返す", async () => {
    const token = await signIn();

    const res = await request("/api/me", { headers: bearer(token.split(".")[0] ?? "") });

    expect(res.status).toBe(401);
  });

  test("トークンでログアウトすると失効し、そのトークンでは 401 になる", async () => {
    const token = await signIn();

    const signOut = await request("/api/auth/sign-out", { method: "POST", headers: bearer(token) });
    const res = await request("/api/me", { headers: bearer(token) });

    expect(signOut.status).toBe(200);
    expect(res.status).toBe(401);
  });

  test("セッションの期限を過ぎたトークンは 401 を返す", async () => {
    const token = await signIn();
    passTo(seconds(8 * 24 * 60 * 60));

    const res = await request("/api/me", { headers: bearer(token) });

    expect(res.status).toBe(401);
  });

  test("画面のセッションを延ばす応答には、トークンを cookie の外に出さない", async () => {
    const webSession = await sessionCookieOf("me@example.com");
    passTo(seconds(2 * 24 * 60 * 60));

    const res = await request("/api/auth/get-session", { headers: { cookie: webSession } });

    expect(res.headers.getSetCookie().join()).toContain("session_token=");
    expect(res.headers.get("set-auth-token")).toBeNull();
  });

  test("ネイティブアプリでログアウトしても、画面のセッションは残る", async () => {
    const webSession = await sessionCookieOf("me@example.com");
    const token = await signIn();

    await request("/api/auth/sign-out", { method: "POST", headers: bearer(token) });
    const res = await request("/api/me", { headers: { cookie: webSession } });

    expect(res.status).toBe(200);
  });

  test("あとから許可リストから外れたユーザーのトークンは 403 を返す", async () => {
    const outsider = await harness.signInAs("outsider@example.com");
    // テスト用のログインの cookie の値は署名つきのセッションのトークンで、Bearer トークンと同じもの
    const cookie = outsider.get("cookie") ?? "";
    const token = cookie.slice(cookie.indexOf("=") + 1);

    const res = await request("/api/me", { headers: bearer(token) });

    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("EMAIL_NOT_ALLOWED");
  });
});
