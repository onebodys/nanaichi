import { Hono } from "hono";
import { bodyOf, respond, userDOOf } from "./api-response.ts";
import type { AppEnv } from "./hono-context.ts";

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
  );
