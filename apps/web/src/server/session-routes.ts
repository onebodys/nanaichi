import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { bodyOf, respond, userDOOf } from "./api-response.ts";
import type { AppEnv } from "./hono-context.ts";

const IMPORT_BODY_MAX_BYTES = 10 * 1024 * 1024;

/**
 * セッションと操作の API。`requireSession` の後ろにつなぐ（app.ts）。
 *
 * 判断と記録はユーザーの UserDO が行い、ここは本文の受け渡しと HTTP への変換だけをする。
 * 時刻はすべてサーバー（UserDO）が受け付けた時刻で記録する（ADR 0007）。
 */
export const sessionRoutes = new Hono<AppEnv>()
  .get("/session/current", async (c) => c.json(await userDOOf(c).getCurrentSession()))
  .post("/session", async (c) => respond(c, await userDOOf(c).startSession(await bodyOf(c))))
  .post("/session/commands", async (c) =>
    respond(c, await userDOOf(c).operateSession(await bodyOf(c))),
  )
  // フェーズの進め方はセッションの計算に使うアカウントの設定なので、セッションの API と並べる（ADR 0016）
  .get("/settings/advance-mode", async (c) => respond(c, await userDOOf(c).getAdvanceMode()))
  .put("/settings/advance-mode", async (c) =>
    respond(c, await userDOOf(c).changeAdvanceMode(await bodyOf(c))),
  )
  // 取り込み（ADR 0020）。画面は束を 1 MB ほどに分けて送る。1件で上限を超えるセッションも送れるよう余裕を持たせる
  .post("/imports", bodyLimit({ maxSize: IMPORT_BODY_MAX_BYTES }), async (c) =>
    respond(c, await userDOOf(c).importSessions(await bodyOf(c))),
  );
