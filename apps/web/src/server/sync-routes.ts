import { Hono } from "hono";
import type { ApiErrorBody } from "../domain/api-error.ts";
import { userDOOf } from "./api-response.ts";
import { credentialOf, type AppEnv } from "./hono-context.ts";

/**
 * 同期の WebSocket（ADR 0012）。`requireSession` の後ろにつなぐ（app.ts）。
 *
 * ログイン中のユーザーの UserDO にそのまま渡し、UserDO が Hibernation API で受け入れる。
 * 書き込みは HTTP のままで、WebSocket はサーバーから画面へ同期メッセージを送るのにだけ使う。
 */
export const syncRoutes = new Hono<AppEnv>().get("/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "WEBSOCKET_UPGRADE_REQUIRED" } satisfies ApiErrorBody, 426);
  }
  // cookie で認証する WebSocket は CORS で守られないので、別のサイトのページから繋がれないよう
  // Origin がこのアプリと同じであることを確かめる（Cross-Site WebSocket Hijacking）。
  // Bearer はブラウザの WebSocket からは付けられず、別のサイトのページには使えないので確かめない。
  // ネイティブアプリ（ADR 0029）は Origin を送らない
  if (credentialOf(c) === "Cookie" && c.req.header("origin") !== new URL(c.req.url).origin) {
    return c.json({ error: "CROSS_ORIGIN_REJECTED" } satisfies ApiErrorBody, 403);
  }
  return userDOOf(c).fetch(c.req.raw);
});
