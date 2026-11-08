import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiErrorBody } from "../domain/api-error.ts";
import { sessionOf, type AppEnv } from "./hono-context.ts";

/** 制限の窓の長さ（秒）。wrangler.jsonc の `ratelimits` の `period` と同じ値 */
const USER_PERIOD_SECONDS = 10;
const NATIVE_AUTH_PERIOD_SECONDS = 60;

const rejectIfOverLimit = async (
  c: Context<AppEnv>,
  limiter: RateLimit,
  key: string,
  periodSeconds: number,
): Promise<Response | undefined> => {
  const { success } = await limiter.limit({ key });
  if (success) {
    return undefined;
  }
  return c.json({ error: "RATE_LIMITED" } satisfies ApiErrorBody, 429, {
    "Retry-After": String(periodSeconds),
  });
};

/**
 * ユーザーごとのリクエストの数を数え、制限（wrangler.jsonc の `ratelimits`）を超えていれば 429 の応答を返す（ADR 0018）。
 * 超えていなければ `undefined`。UserDO を呼ぶ前に確かめ、DO へのリクエストと課金が膨らまないようにする。
 */
export const rejectIfRateLimited = (
  c: Context<AppEnv>,
  userId: string,
): Promise<Response | undefined> =>
  rejectIfOverLimit(c, c.env.USER_RATE_LIMITER, userId, USER_PERIOD_SECONDS);

/** 画面のセッションで使う `/api/*` の制限。`requireSession` の後ろにつなぐ（app.ts） */
export const limitRequestsPerUser = createMiddleware<AppEnv>(async (c, next) => {
  const rejected = await rejectIfRateLimited(c, sessionOf(c).user.id);
  if (rejected !== undefined) {
    return rejected;
  }
  await next();
});

/**
 * ネイティブアプリのログイン（`/api/native-auth/*`、ADR 0029）の制限。まだユーザーが決まらないので、接続元の IP で数える。
 * `start` は Better Auth の API を直接呼ぶので Better Auth のレート制限を通らず、1回ごとに D1 に state の行を書く。
 * Cloudflare を通るリクエストには必ず `cf-connecting-ip` が付く。付かないのはローカルの開発とテストだけで、まとめて数える
 */
export const limitNativeAuthPerClient = createMiddleware<AppEnv>(async (c, next) => {
  const rejected = await rejectIfOverLimit(
    c,
    c.env.NATIVE_AUTH_RATE_LIMITER,
    c.req.header("cf-connecting-ip") ?? "local",
    NATIVE_AUTH_PERIOD_SECONDS,
  );
  if (rejected !== undefined) {
    return rejected;
  }
  await next();
});
