import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Result } from "@praha/byethrow";
import type { ApiErrorBody } from "../domain/api-error.ts";
import type { DeleteJournalEntryError } from "../workflows/delete-journal-entry.ts";
import type { EditJournalEntryError } from "../workflows/edit-journal-entry.ts";
import type { GetTimelineError } from "../workflows/get-timeline.ts";
import type { OperateSessionError } from "../workflows/operate-session.ts";
import type { StartSessionError } from "../workflows/start-session.ts";
import type { WriteJournalEntryError } from "../workflows/write-journal-entry.ts";
import { sessionOf, type AppEnv } from "./hono-context.ts";
import { describeIssuePaths } from "./validation-error.ts";

/** ログイン中のユーザーの UserDO。ユーザーごとに1つ（ADR 0002） */
export const userDOOf = (c: Context<AppEnv>) => c.env.USER_DO.getByName(sessionOf(c).user.id);

/** 本文が JSON でなければ `undefined` を渡し、ワークフローの入力の検証で 400 にする */
export const bodyOf = async (c: Context<AppEnv>): Promise<unknown> =>
  c.req.json<unknown>().catch(() => undefined);

type WorkflowError =
  | StartSessionError
  | OperateSessionError
  | WriteJournalEntryError
  | EditJournalEntryError
  | DeleteJournalEntryError
  | GetTimelineError;

/** 想定内の失敗を HTTP の応答にする。どれもクライアントが直せる失敗なので 4xx */
const errorResponseOf = (
  error: WorkflowError,
): Readonly<{ status: ContentfulStatusCode; body: ApiErrorBody }> => {
  switch (error.kind) {
    case "ValidationError":
      // 入力値はレスポンスに含めず、どの項目が不正かだけを返す（ジャーナル記入の本文は PII）
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
    case "JournalEntryNotFound":
      return { status: 404, body: { error: "JOURNAL_ENTRY_NOT_FOUND" } };
  }
};

// DO の RPC を通ると型が直列化できる形に写される（タプルが配列になるなど）ため、
// 成功の値の型はドメインの型に固定せず受け取る。そのまま JSON にするだけなので困らない。
export const respond = <T>(c: Context<AppEnv>, result: Result.Result<T, WorkflowError>) => {
  if (Result.isSuccess(result)) {
    return c.json(result.value);
  }
  const { status, body } = errorResponseOf(result.error);
  return c.json(body, status);
};
