import { createMiddleware } from "hono/factory";
import { authFor } from "./auth-context.ts";
import type { AppEnv } from "./hono-context.ts";

/**
 * 認証が必要な `/api/*` を守るミドルウェア。
 *
 * セッションが無ければ 401 を返し、以降のハンドラを実行しない。
 * ログインの入口である `/api/auth/*` とヘルスチェックには付けない。
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const session = await authFor(c).api.getSession({ headers: c.req.raw.headers });

  if (session === null) {
    return c.json({ error: "UNAUTHENTICATED" }, 401);
  }

  c.set("session", session);
  await next();
});
