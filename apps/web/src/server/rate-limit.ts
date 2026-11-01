import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiErrorBody } from "../domain/api-error.ts";
import { sessionOf, type AppEnv } from "./hono-context.ts";

/** 制限の窓の長さ（秒）。wrangler.jsonc の `ratelimits` の `period` と同じ値 */
const PERIOD_SECONDS = 10;

/**
 * ユーザーごとのリクエストの数を数え、制限（wrangler.jsonc の `ratelimits`）を超えていれば 429 の応答を返す（ADR 0018）。
 * 超えていなければ `undefined`。UserDO を呼ぶ前に確かめ、DO へのリクエストと課金が膨らまないようにする。
 */
export const rejectIfRateLimited = async (
  c: Context<AppEnv>,
  userId: string,
): Promise<Response | undefined> => {
  const { success } = await c.env.USER_RATE_LIMITER.limit({ key: userId });
  if (success) {
    return undefined;
  }
  return c.json({ error: "RATE_LIMITED" } satisfies ApiErrorBody, 429, {
    "Retry-After": String(PERIOD_SECONDS),
  });
};

/** 画面のセッションで使う `/api/*` の制限。`requireSession` の後ろにつなぐ（app.ts） */
export const limitRequestsPerUser = createMiddleware<AppEnv>(async (c, next) => {
  const rejected = await rejectIfRateLimited(c, sessionOf(c).user.id);
  if (rejected !== undefined) {
    return rejected;
  }
  await next();
});
