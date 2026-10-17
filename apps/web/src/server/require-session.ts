import { createMiddleware } from "hono/factory";
import { Allowlist } from "../domain/allowlist.ts";
import type { ApiErrorBody } from "../domain/api-error.ts";
import { allowlistFor, authFor } from "./auth-context.ts";
import type { AppEnv } from "./hono-context.ts";

/**
 * 認証が必要な `/api/*` を守るミドルウェア。
 *
 * セッションが無ければ 401 を返し、以降のハンドラを実行しない。
 * ログインの入口である `/api/auth/*` とヘルスチェックには付けない。
 *
 * 許可リストはユーザー作成時（`guardUserCreation`）にも照合しているが、それだけでは
 * あとから許可リストから外したユーザーが、作成済みのユーザーと残っているセッションで
 * 使い続けられてしまう。そこでリクエストのたびにも照合し、外れていれば 403 を返す。
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const session = await authFor(c).api.getSession({ headers: c.req.raw.headers });

  if (session === null) {
    return c.json({ error: "UNAUTHENTICATED" } satisfies ApiErrorBody, 401);
  }
  if (!Allowlist.permits(allowlistFor(c), session.user.email)) {
    return c.json({ error: "EMAIL_NOT_ALLOWED" } satisfies ApiErrorBody, 403);
  }

  c.set("session", session);
  await next();
});
