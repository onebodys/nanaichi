import * as v from "valibot";
import { NativeTokenJsonSchema } from "../domain/native-token.ts";

/**
 * ネイティブアプリのログイン（native-auth-routes.ts、ADR 0029）を、Google を通さずにテストで歩くための手順。
 *
 * Google のログインの代わりに、テスト用のログイン（`signInAs`）でセッションを作る。
 * Google から戻ったあとは、Better Auth と同じく `start` が OAuth の state に預けた callbackURL へ進む。
 * Node（auth-test-harness.ts）と Workers（workers-test-harness.ts）の両方から使えるよう、
 * リクエストの送り方と D1 とログインのしかたは呼ぶ側から受け取る。
 */

type Request = (path: string, init?: RequestInit) => Promise<Response>;

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** アプリが作る code_verifier と、そこから求めた S256 の code_challenge */
export const newPkce = async (): Promise<Readonly<{ verifier: string; challenge: string }>> => {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
};

/** `Set-Cookie` の値を、次のリクエストの `Cookie` に載せる `name=value` にする */
const cookiePairsOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .join("; ");

const StateValueSchema = v.pipe(v.string(), v.parseJson(), v.object({ callbackURL: v.string() }));

/**
 * Google から戻ったときに Better Auth がリダイレクトする先。Better Auth は `signInSocial` の callbackURL を
 * OAuth の state として D1 の `verification` に置き、Google から戻った `state` で引き当てて、そこへ戻す。
 */
const callbackURLOf = async (db: D1Database, start: Response): Promise<string> => {
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const value = await db
    .prepare(`select "value" from "verification" where "identifier" = ?`)
    .bind(`auth-state:${state}`)
    .first<string>("value");
  return v.parse(StateValueSchema, value).callbackURL;
};

/**
 * `start` を開く。返す `cookie` は、アプリのブラウザ（ASWebAuthenticationSession）に残る cookie。
 * `callbackURL` は、この流れの Google のログインを終えたときに Better Auth が戻す先
 */
export const startNativeSignIn = async (
  request: Request,
  db: D1Database,
  challenge: string,
): Promise<Readonly<{ response: Response; cookie: string; callbackURL: string }>> => {
  const params = new URLSearchParams({ code_challenge: challenge, code_challenge_method: "S256" });
  // Workers のテストの fetch は既定でリダイレクトをたどり、Google の URL まで同じ Worker に送ってしまう
  const response = await request(`/api/native-auth/start?${params.toString()}`, {
    redirect: "manual",
  });
  return {
    response,
    cookie: cookiePairsOf(response),
    callbackURL: await callbackURLOf(db, response),
  };
};

/**
 * Google から戻ったところ。アプリへ戻すリダイレクトの `code` か `error` を返す。
 * `path` は Better Auth が戻す先で、ふつうは `startNativeSignIn` の `callbackURL`
 */
export const returnFromGoogle = async (
  request: Request,
  cookie: string,
  path = "/api/native-auth/callback",
): Promise<URLSearchParams> => {
  const res = await request(path, {
    headers: { cookie },
    redirect: "manual",
  });
  const location = res.headers.get("location") ?? "";
  if (res.status !== 302 || !location.startsWith("nanaichi://auth/callback?")) {
    throw new Error(`アプリへ戻らなかった: ${res.status} ${location}`);
  }
  return new URL(location).searchParams;
};

export const exchangeCode = (request: Request, code: string, verifier: string) =>
  request("/api/native-auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier }),
  });

/**
 * `start` → ログイン → `callback` → 引き換えを通して、アプリが受け取る Bearer トークンを返す。
 * `signIn` は、Google のログインを終えたあとのセッションの cookie を返す。
 */
export const signInNatively = async (
  request: Request,
  db: D1Database,
  signIn: () => Promise<string>,
): Promise<string> => {
  const { verifier, challenge } = await newPkce();
  const { cookie: flowCookie, callbackURL } = await startNativeSignIn(request, db, challenge);
  const sessionCookie = await signIn();
  const params = await returnFromGoogle(request, `${sessionCookie}; ${flowCookie}`, callbackURL);
  const res = await exchangeCode(request, params.get("code") ?? "", verifier);
  if (res.status !== 200) {
    throw new Error(`トークンと引き換えられなかった: ${res.status}`);
  }
  return v.parse(NativeTokenJsonSchema, await res.json()).token;
};

export const bearer = (token: string): Headers => new Headers({ authorization: `Bearer ${token}` });
