import { Hono } from "hono";
import { authFor } from "./auth-context.ts";
import type { AppEnv } from "./hono-context.ts";

/**
 * `/` の出し分け（ADR 0018）。ログインしていればタイマーの画面（SPA の index.html）、
 * していなければ LP（landing.html）を返す。どちらも URL は `/` のままにする。
 *
 * PWA の `start_url`、ログインのあとの戻り先、通知を押したときに開く画面はどれも `/` なので、
 * ログインしている人の行き先は変わらない。LP にはログインへの導線を置かない（Issue #90）。
 * 画面の出し分けだけで、保護はこれまでどおり `/api/*` の `requireSession` が受け持つ。
 */
export const landingRoutes = new Hono<AppEnv>();

/** ASSETS のうち LP の HTML。`html_handling` の既定で `/landing` が `landing.html` を返す */
const LANDING_PATH = "/landing";

landingRoutes.get("/", async (c) => {
  const session = await authFor(c).api.getSession({ headers: c.req.raw.headers });
  const page = session === null ? LANDING_PATH : "/";
  // 条件付きのリクエスト（If-None-Match）もそのまま渡し、返す HTML の ETag で照合させる
  const asset = await c.env.ASSETS.fetch(new Request(new URL(page, c.req.url), c.req.raw));
  const headers = new Headers(asset.headers);
  // 同じ URL で cookie によって中身が変わるので、キャッシュにそれを伝える
  headers.append("Vary", "Cookie");
  return new Response(asset.body, { status: asset.status, headers });
});
