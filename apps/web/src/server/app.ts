import { Hono } from "hono";
import { authFor } from "./auth-context.ts";
import { canonicalRedirectFor } from "./base-url.ts";
import { type AppEnv, sessionOf } from "./hono-context.ts";
import { journalRoutes } from "./journal-routes.ts";
import { mcpRoutes } from "./mcp-routes.ts";
import { limitRequestsPerUser } from "./rate-limit.ts";
import { requireSession } from "./require-session.ts";
import { sessionRoutes } from "./session-routes.ts";
import { syncRoutes } from "./sync-routes.ts";
import { taskRoutes } from "./task-routes.ts";
import { testSignInRoutes } from "./test-sign-in.ts";

export const app = new Hono<AppEnv>();

// workers.dev へのリクエストは、静的アセットを含めてすべて nanaichi.app の同じパスへ転送する（ADR 0021）。
// 308 にするのは、MCP クライアントの POST などをメソッドと本文を保ったまま転送するため
app.use("*", async (c, next) => {
  const location = canonicalRedirectFor(c.req.url);
  if (location === undefined) {
    return next();
  }
  return c.redirect(location, 308);
});

// MCP クライアントが OAuth のサーバーを見つけるための文書（RFC 8414 / RFC 9728）。仕様でオリジンの直下に置く
// ことになっているので `/api` の外で受け、Better Auth（`mcp()` プラグイン）に答えさせる（ADR 0023）
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
// ループするバグや連続の書き込みで UserDO へのリクエストが膨らまないよう、ユーザーごとに数を制限する（ADR 0018）
authenticated.use("*", limitRequestsPerUser);
authenticated.get("/me", (c) => {
  const { user } = sessionOf(c);
  return c.json({ user: { id: user.id, name: user.name, email: user.email, image: user.image } });
});
authenticated.route("/", sessionRoutes);
authenticated.route("/", journalRoutes);
authenticated.route("/", taskRoutes);
authenticated.route("/", syncRoutes);

api.route("/", authenticated);

// `route` はその時点のルートを写すので、`api` にすべて足してからつなぐ
app.route("/api", api);
// 知らない API は SPA の index.html ではなく 404 にする
app.all("/api/*", (c) => c.notFound());

// 転送を静的アセットにも効かせるため、すべてのリクエストを Worker が先に受けている（wrangler.jsonc の
// `run_worker_first`）。API でなければ静的アセット（SPA・LP・アイコンなど）を返す
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
