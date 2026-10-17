import { Hono } from "hono";
import { bodyOf, respond, userDOOf } from "./api-response.ts";
import type { AppEnv } from "./hono-context.ts";

/**
 * ジャーナル記入とタイムラインの API。`requireSession` の後ろにつなぐ（app.ts）。
 *
 * 判断と記録はユーザーの UserDO が行い、ここは本文の受け渡しと HTTP への変換だけをする。
 * 書いた時刻はサーバー（UserDO）が受け付けた時刻で記録する（ADR 0010）。
 */
export const journalRoutes = new Hono<AppEnv>()
  .post("/journal-entries", async (c) =>
    respond(c, await userDOOf(c).writeJournalEntry(await bodyOf(c))),
  )
  .patch("/journal-entries/:id", async (c) =>
    respond(c, await userDOOf(c).editJournalEntry(c.req.param("id"), await bodyOf(c))),
  )
  .delete("/journal-entries/:id", async (c) =>
    respond(c, await userDOOf(c).deleteJournalEntry(c.req.param("id"))),
  )
  // `c.req.query()` はプロトタイプのないオブジェクトで DO の RPC で送れないので、使う値だけを取り出す
  .get("/timeline", async (c) =>
    respond(c, await userDOOf(c).getTimeline({ before: c.req.query("before") })),
  );
