import { Hono } from "hono";
import { authFor } from "./auth-context.ts";
import { type AppEnv, sessionOf } from "./hono-context.ts";
import { requireSession } from "./require-session.ts";

export const app = new Hono<AppEnv>().basePath("/api");

// 認証不要。ヘルスチェックと、ログインの入口である Better Auth 本体。
app.get("/health", (c) => c.json({ status: "ok" }));
app.all("/auth/*", (c) => authFor(c).handler(c.req.raw));

// 認証必須。ここに足したエンドポイントは requireSession で自動的に保護される。
const authenticated = new Hono<AppEnv>();
authenticated.use("*", requireSession);
authenticated.get("/me", (c) => {
  const { user } = sessionOf(c);
  return c.json({ user: { id: user.id, name: user.name, email: user.email, image: user.image } });
});

app.route("/", authenticated);
