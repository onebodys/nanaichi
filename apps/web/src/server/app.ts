import { Hono } from "hono";
import { authFor } from "./auth-context.ts";
import { type AppEnv, sessionOf } from "./hono-context.ts";
import { journalRoutes } from "./journal-routes.ts";
import { mcpRoutes } from "./mcp-routes.ts";
import { requireSession } from "./require-session.ts";
import { sessionRoutes } from "./session-routes.ts";
import { syncRoutes } from "./sync-routes.ts";
import { testSignInRoutes } from "./test-sign-in.ts";

export const app = new Hono<AppEnv>();

// MCP クライアントが OAuth のサーバーを見つけるための文書（RFC 8414 / RFC 9728）。仕様でオリジンの直下に置く
// ことになっているので `/api` の外で受け、Better Auth（`mcp()` プラグイン）に答えさせる（ADR 0017）
app.get("/.well-known/*", (c) => authFor(c).handler(c.req.raw));

const api = new Hono<AppEnv>();

// 認証不要。ヘルスチェックと、ログインの入口である Better Auth 本体。
api.get("/health", (c) => c.json({ status: "ok" }));
api.all("/auth/*", (c) => authFor(c).handler(c.req.raw));
// MCP サーバー。画面のセッションではなく OAuth のアクセストークンで守る（mcp-routes.ts）
api.route("/", mcpRoutes);
// Google を通さないテスト用のログイン。ローカルの開発サーバーと E2E でだけ開き、それ以外では 404（ADR 0008）
api.route("/", testSignInRoutes);

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

api.route("/", authenticated);

// `route` はその時点のルートを写すので、`api` にすべて足してからつなぐ
app.route("/api", api);
