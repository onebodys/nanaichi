import * as v from "valibot";

/**
 * API が想定内の失敗のときに返すエラーの種類。サーバーは応答の本文の `error` にこれを入れ、
 * クライアントは本文をスキーマで検証してから、種類ごとに画面での扱いを決める（AGENTS.md §5）。
 */
const API_ERROR_CODES = [
  /** ログインしていない（401） */
  "UNAUTHENTICATED",
  /** 許可リストに載っていない（403） */
  "EMAIL_NOT_ALLOWED",
  /** リクエストの本文やクエリが不正（400） */
  "INVALID_REQUEST",
  /** 同時に持てるセッションは1つまで（409） */
  "SESSION_ALREADY_IN_PROGRESS",
  /** セッションの外での操作やジャーナル記入（409） */
  "NO_SESSION_IN_PROGRESS",
  /** その状態ではできない操作（409） */
  "OPERATION_REJECTED",
  /** 記録済みの操作イベントと同じ ID で別の操作（409、ADR 0007） */
  "EVENT_ID_CONFLICT",
  /** 使えるタグの種類の上限を超える（409、ADR 0013） */
  "TAG_LIMIT_EXCEEDED",
  /** ジャーナル記入が記録されていないか、削除されている（404、ADR 0010） */
  "JOURNAL_ENTRY_NOT_FOUND",
  /** 削除するタグか付け替え先のタグが、どの記入にもついていない（404、ADR 0017） */
  "TAG_NOT_FOUND",
  /** `GET /api/ws` に WebSocket の Upgrade がない（426、ADR 0012） */
  "WEBSOCKET_UPGRADE_REQUIRED",
  /** `GET /api/ws` の Origin がこのアプリと違う（403、ADR 0012） */
  "CROSS_ORIGIN_REJECTED",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * エラーの応答の本文。`error` のほかに、種類ごとの補足（`paths` や `operation`）が付くことがある。
 * 補足は今のところ画面で使わないので、`error` だけを検証する。
 */
export const ApiErrorBodyJsonSchema = v.looseObject({ error: v.picklist(API_ERROR_CODES) });

/** サーバーが返すエラーの応答の本文。`satisfies ApiErrorBody` で種類の書き間違いを型で防ぐ */
export type ApiErrorBody = v.InferOutput<typeof ApiErrorBodyJsonSchema>;
