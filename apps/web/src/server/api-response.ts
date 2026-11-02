import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Result } from "@praha/byethrow";
import type { ApiErrorBody, ApiErrorCode } from "../domain/api-error.ts";
import { rejectionCodeOf, type WorkflowError } from "../workflows/rejection-code.ts";
import { sessionOf, type AppEnv } from "./hono-context.ts";
import { describeIssuePaths } from "./validation-error.ts";

/** ログイン中のユーザーの UserDO。ユーザーごとに1つ（ADR 0002） */
export const userDOOf = (c: Context<AppEnv>) => c.env.USER_DO.getByName(sessionOf(c).user.id);

/** 本文が JSON でなければ `undefined` を渡し、ワークフローの入力の検証で 400 にする */
export const bodyOf = async (c: Context<AppEnv>): Promise<unknown> =>
  c.req.json<unknown>().catch(() => undefined);

const statusOf = (code: ApiErrorCode): ContentfulStatusCode => {
  switch (code) {
    case "INVALID_REQUEST":
      return 400;
    case "UNAUTHENTICATED":
      return 401;
    case "EMAIL_NOT_ALLOWED":
    case "CROSS_ORIGIN_REJECTED":
      return 403;
    case "JOURNAL_ENTRY_NOT_FOUND":
    case "TAG_NOT_FOUND":
      return 404;
    case "SESSION_ALREADY_IN_PROGRESS":
    case "NO_SESSION_IN_PROGRESS":
    case "OPERATION_REJECTED":
    case "EVENT_ID_CONFLICT":
    case "TAG_LIMIT_EXCEEDED":
      return 409;
    case "WEBSOCKET_UPGRADE_REQUIRED":
      return 426;
    case "RATE_LIMITED":
      return 429;
  }
};

const extrasOf = (error: WorkflowError): Omit<ApiErrorBody, "error"> => {
  switch (error.kind) {
    case "ValidationError":
      // 入力値はレスポンスに含めず、どの項目が不正かだけを返す（ジャーナル記入の本文は PII）
      return { paths: describeIssuePaths(error) };
    case "ReassignToSameTag":
      return { paths: ["to"] };
    case "OperationRejected":
      return { operation: error.operation, during: error.during };
    case "TagLimitExceeded":
      return { limit: error.limit };
    case "SessionAlreadyInProgress":
    case "NoSessionInProgress":
    case "EventIdConflict":
    case "JournalEntryNotFound":
    case "TagNotFound":
      return {};
  }
};

const errorResponseOf = (
  error: WorkflowError,
): Readonly<{ status: ContentfulStatusCode; body: ApiErrorBody }> => {
  const code = rejectionCodeOf(error);
  return { status: statusOf(code), body: { error: code, ...extrasOf(error) } };
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
