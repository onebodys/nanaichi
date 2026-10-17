import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Result } from "@praha/byethrow";
import type { OperateSessionError } from "../workflows/operate-session.ts";
import type { StartSessionError } from "../workflows/start-session.ts";
import { type AppEnv, sessionOf } from "./hono-context.ts";
import { describeIssuePaths } from "./validation-error.ts";

/** ログイン中のユーザーの UserDO。ユーザーごとに1つ（ADR 0002） */
const userDOOf = (c: Context<AppEnv>) => c.env.USER_DO.getByName(sessionOf(c).user.id);

/** 本文が JSON でなければ `undefined` を渡し、ワークフローの入力の検証で 400 にする */
const bodyOf = async (c: Context<AppEnv>): Promise<unknown> =>
  c.req.json<unknown>().catch(() => undefined);

type SessionError = StartSessionError | OperateSessionError;

/** 想定内の失敗を HTTP の応答にする。どれもクライアントが直せる失敗なので 4xx */
const errorResponseOf = (
  error: SessionError,
): Readonly<{ status: ContentfulStatusCode; body: Readonly<Record<string, unknown>> }> => {
  switch (error.kind) {
    case "ValidationError":
      // 入力値はレスポンスに含めず、どの項目が不正かだけを返す
      return { status: 400, body: { error: "INVALID_REQUEST", paths: describeIssuePaths(error) } };
    case "SessionAlreadyInProgress":
      return { status: 409, body: { error: "SESSION_ALREADY_IN_PROGRESS" } };
    case "NoSessionInProgress":
      return { status: 409, body: { error: "NO_SESSION_IN_PROGRESS" } };
    case "OperationRejected":
      return {
        status: 409,
        body: { error: "OPERATION_REJECTED", operation: error.operation, during: error.during },
      };
    case "EventIdConflict":
      return { status: 409, body: { error: "EVENT_ID_CONFLICT" } };
  }
};

// DO の RPC を通ると型が直列化できる形に写される（タプルが配列になるなど）ため、
// 成功の値の型は `SessionSnapshot` に固定せず受け取る。そのまま JSON にするだけなので困らない。
const respond = <T>(c: Context<AppEnv>, result: Result.Result<T, SessionError>) => {
  if (Result.isSuccess(result)) {
    return c.json(result.value);
  }
  const { status, body } = errorResponseOf(result.error);
  return c.json(body, status);
};

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
