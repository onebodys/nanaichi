import { Hono } from "hono";
import { bodyOf, respond, userDOOf } from "./api-response.ts";
import type { AppEnv } from "./hono-context.ts";

/**
 * タスクの API（ADR 0026）。`requireSession` の後ろにつなぐ（app.ts）。
 *
 * 判断と記録はユーザーの UserDO が行い、ここは本文の受け渡しと HTTP への変換だけをする。
 */
export const taskRoutes = new Hono<AppEnv>()
  // ToDo を使うかどうかはアカウントの設定で、サーバーが判断モデルを呼ぶかの判断に使う（ADR 0027）
  .get("/settings/tasks", async (c) => respond(c, await userDOOf(c).getTaskSetting()))
  .put("/settings/tasks", async (c) =>
    respond(c, await userDOOf(c).changeTaskSetting(await bodyOf(c))),
  )
  .get("/tasks", async (c) => respond(c, await userDOOf(c).getTasks()))
  .post("/tasks", async (c) => respond(c, await userDOOf(c).createTask(await bodyOf(c))))
  .patch("/tasks/:id", async (c) =>
    respond(c, await userDOOf(c).renameTask(c.req.param("id"), await bodyOf(c))),
  )
  .post("/tasks/:id/complete", async (c) =>
    respond(c, await userDOOf(c).completeTask(c.req.param("id"))),
  )
  .post("/tasks/:id/reopen", async (c) =>
    respond(c, await userDOOf(c).reopenTask(c.req.param("id"))),
  )
  .delete("/tasks/:id", async (c) => respond(c, await userDOOf(c).deleteTask(c.req.param("id"))));
