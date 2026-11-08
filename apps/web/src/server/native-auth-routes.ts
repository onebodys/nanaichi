import { Result } from "@praha/byethrow";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import * as v from "valibot";
import { Allowlist } from "../domain/allowlist.ts";
import type { ApiErrorBody } from "../domain/api-error.ts";
import type { NativeToken } from "../domain/native-token.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import { bodyOf } from "./api-response.ts";
import { authConfigFor, authFor } from "./auth-context.ts";
import type { AppEnv, AuthSession } from "./hono-context.ts";
import { limitNativeAuthPerClient } from "./rate-limit.ts";
import { describeIssuePaths } from "./validation-error.ts";

/**
 * ネイティブアプリのログイン（ADR 0029）。PKCE（RFC 7636）の形で、トークンをカスタム URL スキームに載せない。
 *
 * 1. アプリが `ASWebAuthenticationSession` で `GET /api/native-auth/start?code_challenge=..&code_challenge_method=S256`
 *    を開く。challenge と、この流れの印（乱数）を署名つきの cookie に入れて、Google のログインへ送る
 * 2. Google のログインを終えると Better Auth がセッションを作り、`GET /api/native-auth/callback?flow=<印>` へ戻す。
 *    印が cookie と同じで、この流れで作られたセッションにだけ使い捨てのコード（60 秒）を発行し、
 *    `nanaichi://auth/callback?code=..` へ戻す
 * 3. アプリが `POST /api/native-auth/token` に `code` と `code_verifier` を送り、セッションのトークンを受け取る
 *
 * 同じスキームを別のアプリが登録してコードを横取りしても、code_verifier を持っていないので引き換えられない。
 */

const APP_CALLBACK_URL = "nanaichi://auth/callback";
const CALLBACK_PATH = "/api/native-auth/callback";
const FLOW_COOKIE = "nanaichi_native_sign_in";
/** 流れの cookie の署名の鍵を、セッションのトークンの署名と分けるための用途の名前 */
const FLOW_COOKIE_KEY_PURPOSE = "nanaichi:native-sign-in-flow:v1";
/** Google のログインを終えるまでの猶予 */
const FLOW_MAX_AGE_SECONDS = 600;
/** コードの期限。アプリはリダイレクトを受けたらすぐ引き換える */
const CODE_TTL_MS = 60_000;

/** S256 の challenge は SHA-256 の 32 バイトを base64url（パディングなし）にした 43 文字。流れの印も同じ形 */
const Base64Url32BytesSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));

const StartQuerySchema = v.object({
  code_challenge: Base64Url32BytesSchema,
  // plain は challenge がそのまま verifier になり、横取りしたコードと合わせて引き換えられてしまうので受けない
  code_challenge_method: v.literal("S256"),
});

/**
 * ログインを始めたときに cookie に入れる値。`startedAt` は UNIX ミリ秒。
 * `nonce` は callbackURL の `?flow=` にも載せ、Better Auth が OAuth の state としてサーバー側に預かる
 */
const SignInFlowSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({
    codeChallenge: Base64Url32BytesSchema,
    nonce: Base64Url32BytesSchema,
    startedAt: v.number(),
  }),
);
type SignInFlow = v.InferOutput<typeof SignInFlowSchema>;

const ExchangeRequestSchema = v.object({
  code: v.pipe(v.string(), v.nonEmpty(), v.maxLength(128)),
  // RFC 7636 の code_verifier は unreserved の文字で 43〜128 文字
  code_verifier: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._~-]{43,128}$/)),
});

const IssuedCodeRowSchema = v.object({
  codeChallenge: v.string(),
  sessionId: v.string(),
  expiresAt: v.number(),
});

/** 発行済みで、まだ引き換えていないコード */
type IssuedCode = Readonly<{ codeChallenge: string; sessionId: string; expiresAt: Date }>;

/** コードを発行できなかった理由。アプリには `?error=` で渡す */
type CallbackFailure = Readonly<{ kind: "EmailNotAllowed" }> | Readonly<{ kind: "SignInFailed" }>;

/** 引き換えられないコード。知らない・使用済み・期限切れ・code_verifier の違いを、アプリにもログにも区別して出さない */
type InvalidGrant = Readonly<{ kind: "InvalidGrant" }>;

const invalidGrant: InvalidGrant = { kind: "InvalidGrant" };
const signInFailed: CallbackFailure = { kind: "SignInFailed" };

const parseStartQuery = schemaResult(StartQuerySchema);
const parseSignInFlow = schemaResult(SignInFlowSchema);
const parseExchangeRequest = schemaResult(ExchangeRequestSchema);

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const s256 = async (verifier: string): Promise<string> =>
  base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

const newRandom = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** 長さが同じなら、どこで違っても同じ時間で比べる */
const sameString = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

const hmacSha256 = async (secret: string, data: string): Promise<ArrayBuffer> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
};

/**
 * セッションのトークンに、cookie と同じ署名を付ける（better-call の `signCookieValue` と同じ形）。
 * bearer プラグインは署名つきのトークンだけを受ける（auth.ts の `requireSignature`）。
 */
const signSessionToken = async (token: string, secret: string): Promise<string> =>
  `${token}.${btoa(String.fromCharCode(...new Uint8Array(await hmacSha256(secret, token))))}`;

/**
 * 流れの cookie の署名の鍵。secret をそのまま使うと、`start` を開くだけで、セッションのトークンと同じ鍵で
 * 署名された文字列が手に入り、bearer プラグインの署名の確かめを通ってしまう。用途ごとに鍵を分ける
 */
const flowCookieKey = (secret: string): Promise<ArrayBuffer> =>
  hmacSha256(secret, FLOW_COOKIE_KEY_PURPOSE);

const flowCookieOptions = (c: Context<AppEnv>): CookieOptions => ({
  path: "/api/native-auth",
  httpOnly: true,
  secure: new URL(c.req.url).protocol === "https:",
  // Google から戻るトップレベルの遷移でも送られるよう Lax にする（Better Auth の state の cookie と同じ）
  sameSite: "Lax",
  maxAge: FLOW_MAX_AGE_SECONDS,
});

const startSignIn = async (c: Context<AppEnv>, flow: SignInFlow) => {
  // callbackURL は Better Auth が OAuth の state としてサーバー側（D1 の verification）に預け、この流れの
  // Google のログインを終えたときにだけそこへ戻す。画面のログインから戻るリダイレクトには `?flow=` が付かない。
  // 失敗したときの戻り先にはコードを発行しないので、印を付けない
  const { headers, response } = await authFor(c).api.signInSocial({
    body: {
      provider: "google",
      callbackURL: `${CALLBACK_PATH}?${new URLSearchParams({ flow: flow.nonce }).toString()}`,
      errorCallbackURL: CALLBACK_PATH,
    },
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
  if (response.url === undefined) {
    throw new Error("Google のログインの URL が返ってこなかった");
  }
  // Better Auth の state の cookie。Google から戻ったときに、同じブラウザで始めたことを確かめる
  for (const cookie of headers.getSetCookie()) {
    c.header("Set-Cookie", cookie, { append: true });
  }
  await setSignedCookie(
    c,
    FLOW_COOKIE,
    JSON.stringify(flow),
    await flowCookieKey(authConfigFor(c).secret),
    flowCookieOptions(c),
  );
  return c.redirect(response.url);
};

/** Better Auth が `errorCallbackURL` に付ける `?error=`。許可リストで断ったとき以外は理由を区別しない */
const ensureNoProviderError = (error: string | undefined): Result.Result<void, CallbackFailure> => {
  if (error === undefined) {
    return Result.succeed();
  }
  return Result.fail(error === "EMAIL_NOT_ALLOWED" ? { kind: "EmailNotAllowed" } : signInFailed);
};

/** 同じブラウザで `start` を開いていなければ cookie がなく、コードは発行しない */
const readFlow = async (
  c: Context<AppEnv>,
): Promise<Result.Result<SignInFlow, CallbackFailure>> => {
  const raw = await getSignedCookie(c, await flowCookieKey(authConfigFor(c).secret), FLOW_COOKIE);
  const flow = parseSignInFlow(raw);
  return Result.isSuccess(flow) ? flow : Result.fail(signInFailed);
};

const loadSession = async (
  c: Context<AppEnv>,
): Promise<Result.Result<AuthSession, CallbackFailure>> => {
  const session = await authFor(c).api.getSession({ headers: c.req.raw.headers });
  return session === null ? Result.fail(signInFailed) : Result.succeed(session);
};

const ensureAllowed =
  (allowlist: Allowlist) =>
  (session: AuthSession): Result.Result<void, CallbackFailure> =>
    Allowlist.permits(allowlist, session.user.email)
      ? Result.succeed()
      : Result.fail({ kind: "EmailNotAllowed" });

/**
 * Better Auth が、この流れの Google のログインを終えて戻したリダイレクトであること。
 *
 * cookie があるだけでは足りない。スキームを横取りしたアプリは、自分の challenge で `start` を開かせて cookie を
 * 置いておき、ユーザーが画面で普通にログインしたあとでブラウザを callback へ送れば、そのセッションにコードを
 * 発行させられる。`?flow=` の印は Better Auth がサーバー側の state から戻すリダイレクトにしか付かない。
 */
const ensureSameFlow = (
  flow: SignInFlow,
  returnedNonce: string | undefined,
): Result.Result<void, CallbackFailure> =>
  returnedNonce !== undefined && sameString(returnedNonce, flow.nonce)
    ? Result.succeed()
    : Result.fail(signInFailed);

/**
 * セッションが、この流れの Google のログインで作られたものであること。
 *
 * ブラウザに前からある画面のセッションには発行しない。そうしないと、ログイン済みのブラウザで
 * 別のアプリが用意した challenge の `start` を開かされただけで、そのアプリにトークンが渡る。
 * この流れで作ったセッションなら、Google の画面でアカウントを選ぶ操作を必ず挟む。
 */
const ensureSignedInDuring = (
  flow: SignInFlow,
  session: AuthSession,
): Result.Result<void, CallbackFailure> =>
  session.session.createdAt.getTime() >= flow.startedAt
    ? Result.succeed()
    : Result.fail(signInFailed);

/** コードを1つ発行して D1 に置く。ついでに期限を過ぎた行を消す */
const saveCode =
  (db: D1Database, now: Date) =>
  async (code: Readonly<{ code: string } & IssuedCode>): Promise<Result.Result<string, never>> => {
    await db.batch([
      db.prepare(`delete from "nativeAuthCode" where "expiresAt" < ?`).bind(now.getTime()),
      db
        .prepare(
          `insert into "nativeAuthCode" ("code", "codeChallenge", "sessionId", "expiresAt") values (?, ?, ?, ?)`,
        )
        .bind(code.code, code.codeChallenge, code.sessionId, code.expiresAt.getTime()),
    ]);
    return Result.succeed(code.code);
  };

const issueCode = (c: Context<AppEnv>, now: Date) =>
  Result.pipe(
    Result.do(),
    Result.andThrough(() => ensureNoProviderError(c.req.query("error"))),
    Result.bind("flow", () => readFlow(c)),
    Result.andThrough(({ flow }) => ensureSameFlow(flow, c.req.query("flow"))),
    Result.bind("session", () => loadSession(c)),
    Result.andThrough(({ session }) => ensureAllowed(authConfigFor(c).allowlist)(session)),
    Result.andThrough(({ flow, session }) => ensureSignedInDuring(flow, session)),
    Result.andThen(({ flow, session }) =>
      saveCode(
        authConfigFor(c).database,
        now,
      )({
        code: newRandom(),
        codeChallenge: flow.codeChallenge,
        sessionId: session.session.id,
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      }),
    ),
  );

const errorCodeOf = (failure: CallbackFailure): string => {
  switch (failure.kind) {
    case "EmailNotAllowed":
      return "EMAIL_NOT_ALLOWED";
    case "SignInFailed":
      return "SIGN_IN_FAILED";
  }
};

const appCallbackURL = (result: Result.Result<string, CallbackFailure>): string => {
  const params = Result.isSuccess(result)
    ? new URLSearchParams({ code: result.value })
    : new URLSearchParams({ error: errorCodeOf(result.error) });
  return `${APP_CALLBACK_URL}?${params.toString()}`;
};

/** コードを取り出し、同時に消す。同じコードで2回来ても、2回目は見つからない */
const takeCode =
  (db: D1Database) =>
  async (code: string): Promise<Result.Result<IssuedCode, InvalidGrant>> => {
    const row = await db
      .prepare(
        `delete from "nativeAuthCode" where "code" = ? returning "codeChallenge", "sessionId", "expiresAt"`,
      )
      .bind(code)
      .first();
    if (row === null) {
      return Result.fail(invalidGrant);
    }
    const parsed = v.parse(IssuedCodeRowSchema, row);
    return Result.succeed({ ...parsed, expiresAt: new Date(parsed.expiresAt) });
  };

/** 期限内で、送られた code_verifier から求めた challenge が発行したときのものと同じなら、そのセッションの ID */
const ensureRedeemable = (
  issued: IssuedCode,
  verifierChallenge: string,
  now: Date,
): Result.Result<string, InvalidGrant> =>
  now < issued.expiresAt && verifierChallenge === issued.codeChallenge
    ? Result.succeed(issued.sessionId)
    : Result.fail(invalidGrant);

/** 引き換えるまでにログアウトしていれば、セッションの行はない */
const loadSignedToken =
  (db: D1Database, secret: string) =>
  async (sessionId: string): Promise<Result.Result<NativeToken, InvalidGrant>> => {
    const token = await db
      .prepare(`select "token" from "session" where "id" = ?`)
      .bind(sessionId)
      .first<string>("token");
    if (token === null) {
      return Result.fail(invalidGrant);
    }
    return Result.succeed({ token: await signSessionToken(token, secret) });
  };

const exchangeCode = (c: Context<AppEnv>, raw: unknown, now: Date) => {
  const { database, secret } = authConfigFor(c);
  return Result.pipe(
    Result.do(),
    Result.bind("request", () => parseExchangeRequest(raw)),
    Result.bind("issued", ({ request }) => takeCode(database)(request.code)),
    Result.bind("verifierChallenge", async ({ request }) =>
      Result.succeed(await s256(request.code_verifier)),
    ),
    Result.andThen(({ issued, verifierChallenge }) =>
      ensureRedeemable(issued, verifierChallenge, now),
    ),
    Result.andThen(loadSignedToken(database, secret)),
  );
};

const exchangeErrorOf = (error: ValidationError | InvalidGrant): ApiErrorBody => {
  switch (error.kind) {
    case "ValidationError":
      return { error: "INVALID_REQUEST", paths: describeIssuePaths(error) };
    case "InvalidGrant":
      return { error: "INVALID_GRANT" };
  }
};

/** 認証不要。`requireSession` の外につなぐ（app.ts） */
export const nativeAuthRoutes = new Hono<AppEnv>()
  .use("/native-auth/*", limitNativeAuthPerClient)
  .get("/native-auth/start", async (c) => {
    const query = parseStartQuery(c.req.query());
    if (Result.isFailure(query)) {
      return c.json(
        { error: "INVALID_REQUEST", paths: describeIssuePaths(query.error) } satisfies ApiErrorBody,
        400,
      );
    }
    return startSignIn(c, {
      codeChallenge: query.value.code_challenge,
      nonce: newRandom(),
      startedAt: Date.now(),
    });
  })
  .get("/native-auth/callback", async (c) => {
    const result = await issueCode(c, new Date());
    deleteCookie(c, FLOW_COOKIE, flowCookieOptions(c));
    return c.redirect(appCallbackURL(result));
  })
  .post("/native-auth/token", async (c) => {
    const result = await exchangeCode(c, await bodyOf(c), new Date());
    if (Result.isFailure(result)) {
      return c.json(exchangeErrorOf(result.error), 400);
    }
    return c.json(result.value satisfies NativeToken);
  });
