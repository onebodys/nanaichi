import { Hono } from "hono";
import { authFor } from "./auth-context.ts";
import { type AppEnv, sessionOf } from "./hono-context.ts";
import { journalRoutes } from "./journal-routes.ts";
import { requireSession } from "./require-session.ts";
import { sessionRoutes } from "./session-routes.ts";
import { syncRoutes } from "./sync-routes.ts";
import { testSignInRoutes } from "./test-sign-in.ts";

export const app = new Hono<AppEnv>().basePath("/api");

// 認証不要。ヘルスチェックと、ログインの入口である Better Auth 本体。
app.get("/health", (c) => c.json({ status: "ok" }));
app.all("/auth/*", (c) => authFor(c).handler(c.req.raw));
// Google を通さないテスト用のログイン。ローカルの開発サーバーと E2E でだけ開き、それ以外では 404（ADR 0008）
app.route("/", testSignInRoutes);

// 認証必須。ここに足したエンドポイントは requireSession で自動的に保護される。
const authenticated = new Hono<AppEnv>();
authenticated.use("*", requireSession);
authenticated.get("/me", (c) => {
  const { user } = sessionOf(c);
  return c.json({ user: { id: user.id, name: user.name, email: user.email, image: user.image } });
});
authenticated.route("/", sessionRoutes);
authenticated.route("/", journalRoutes);
authenticated.route("/", syncRoutes);

app.route("/", authenticated);
