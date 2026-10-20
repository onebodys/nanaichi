import { Hono } from "hono";
import { bodyOf, respond, userDOOf } from "./api-response.ts";
import type { AppEnv } from "./hono-context.ts";

/**
 * ジャーナル記入・タグ・タイムライン・ジャーナル記入の見返し・スタッツの API。`requireSession` の後ろにつなぐ（app.ts）。
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
  .get("/tags", async (c) => respond(c, await userDOOf(c).getTags()))
  // `c.req.query()` はプロトタイプのないオブジェクトで DO の RPC で送れないので、使う値だけを取り出す
  .get("/timeline", async (c) =>
    respond(c, await userDOOf(c).getTimeline({ before: c.req.query("before") })),
  )
  // ジャーナル記入を見返す（Issue #83）。日付は端末のタイムゾーンで区切るので、画面がタイムゾーンを送る
  .get("/journal-calendar", async (c) =>
    respond(
      c,
      await userDOOf(c).getJournalCalendar({
        month: c.req.query("month"),
        timeZone: c.req.query("timeZone"),
      }),
    ),
  )
  .get("/journal-entries/by-date", async (c) =>
    respond(
      c,
      await userDOOf(c).getEntriesOnDate({
        date: c.req.query("date"),
        timeZone: c.req.query("timeZone"),
      }),
    ),
  )
  .get("/journal-entries/by-tag", async (c) =>
    respond(
      c,
      await userDOOf(c).getEntriesWithTag({
        tag: c.req.query("tag"),
        before: c.req.query("before"),
      }),
    ),
  )
  // 日付と時間帯は端末のタイムゾーンで区切るので、画面がタイムゾーンを送る（ADR 0014）
  .get("/stats", async (c) =>
    respond(
      c,
      await userDOOf(c).getStats({
        period: c.req.query("period"),
        timeZone: c.req.query("timeZone"),
      }),
    ),
  );
