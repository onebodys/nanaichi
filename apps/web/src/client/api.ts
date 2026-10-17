import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Result } from "@praha/byethrow";
import { ApiErrorBodyJsonSchema, type ApiErrorCode } from "../domain/api-error.ts";
import { schemaResult } from "../domain/schema-result.ts";
import type { SessionEventId, SessionOperation } from "../domain/session-event.ts";
import {
  DeletedJournalEntryJsonSchema,
  JournalEntryJsonSchema,
  type DeletedJournalEntry,
  type JournalEntry,
  type JournalEntryId,
} from "../domain/journal-entry.ts";
import { SessionSnapshotJsonSchema, type SessionSnapshot } from "../domain/session.ts";
import { TimelinePageJsonSchema, type TimelinePage } from "../domain/timeline.ts";

/**
 * API の通信層（AGENTS.md §5）。
 *
 * 画面は fetch を直接呼ばず、ここを通す。応答はかならず `domain/` のスキーマで検証し、
 * 失敗も含めて byethrow の Result で返す。画面は `ApiError` の `kind` で扱いを決める。
 */

export type ApiError =
  /** 通信できなかった（オフラインなど）。やり直せば通りうる */
  | Readonly<{ kind: "NetworkError" }>
  /** API が想定内の失敗を返した。`code` で扱いを決める（`UNAUTHENTICATED` ならログイン画面へ） */
  | Readonly<{ kind: "ApiRejected"; status: number; code: ApiErrorCode }>
  /** 応答が JSON でないか、スキーマに合わない。サーバーとクライアントの食い違いか障害 */
  | Readonly<{ kind: "UnexpectedResponse"; status: number }>;

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

/** 本文まで読んだ応答。本文はまだ検証していない */
type ReceivedResponse = Readonly<{ ok: boolean; status: number; body: unknown }>;

const send =
  (fetchApi: Fetch) =>
  (path: string, init: RequestInit | undefined): Result.ResultAsync<Response, ApiError> =>
    Result.try({
      try: () => fetchApi(path, init),
      catch: (): ApiError => ({ kind: "NetworkError" }),
    });

const receive = (response: Response): Result.ResultAsync<ReceivedResponse, ApiError> =>
  Result.try({
    try: async () => {
      const body: unknown = await response.json();
      return { ok: response.ok, status: response.status, body };
    },
    catch: (): ApiError => ({ kind: "UnexpectedResponse", status: response.status }),
  });

const parseErrorBody = schemaResult(ApiErrorBodyJsonSchema);

/**
 * 成功の応答はそのエンドポイントのスキーマで、失敗の応答はエラーの本文のスキーマで検証する。
 *
 * 検証の失敗（`ValidationError`）は外に出さない。指摘には応答の値（今後はジャーナル記入の本文も）が
 * 含まれうるため、どの応答が食い違ったかは HTTP のステータスだけで伝える。
 */
const decode =
  <T>(schema: StandardSchemaV1<unknown, T>) =>
  (response: ReceivedResponse): Result.Result<T, ApiError> => {
    const unexpected: ApiError = { kind: "UnexpectedResponse", status: response.status };

    if (response.ok) {
      return Result.pipe(
        schemaResult(schema)(response.body),
        Result.mapError(() => unexpected),
      );
    }
    return Result.pipe(
      parseErrorBody(response.body),
      Result.mapError(() => unexpected),
      Result.andThen((body): Result.Result<never, ApiError> =>
        Result.fail({ kind: "ApiRejected", status: response.status, code: body.error }),
      ),
    );
  };

/** リクエストを送り、応答の本文を読み、スキーマで検証する */
const requestApi =
  (fetchApi: Fetch) =>
  <T>(
    path: string,
    schema: StandardSchemaV1<unknown, T>,
    init?: RequestInit,
  ): Result.ResultAsync<T, ApiError> =>
    Result.pipe(
      send(fetchApi)(path, init),
      Result.andThen(receive),
      Result.andThen(decode(schema)),
    );

const sendJson = (method: "POST" | "PATCH", body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const postJson = (body: unknown): RequestInit => sendJson("POST", body);

/**
 * API のクライアントを作る。`fetchApi` はテストで差し替えるためのもので、画面からは省略する。
 * SPA と API は同じ origin なので、ログインの cookie はそのまま送られる。
 */
export const createApiClient = (
  fetchApi: Fetch = (path, init) => fetch(path, init),
): Readonly<{
  /** `GET /api/session/current`: 現在のセッションのスナップショット */
  getCurrentSession: () => Result.ResultAsync<SessionSnapshot, ApiError>;
  /**
   * `POST /api/session`: セッションを開始する。`id` は開始の操作イベントの ID（ADR 0007）。
   * やり直すときは同じ ID で送れば、二重に開始しない。
   */
  startSession: (id: SessionEventId) => Result.ResultAsync<SessionSnapshot, ApiError>;
  /** `POST /api/session/commands`: セッションに操作を1つ加える。`id` は操作イベントの ID */
  operateSession: (
    id: SessionEventId,
    kind: SessionOperation["kind"],
  ) => Result.ResultAsync<SessionSnapshot, ApiError>;
  /**
   * `POST /api/journal-entries`: ジャーナル記入を書く。`id` は記入の ID（ADR 0010）。
   * やり直すときは同じ ID で送れば、二重に書かない。本文は送るときだけ取り出す
   */
  writeJournalEntry: (
    id: JournalEntryId,
    body: string,
  ) => Result.ResultAsync<JournalEntry, ApiError>;
  /** `PATCH /api/journal-entries/:id`: 記入の本文を書き直す */
  editJournalEntry: (
    id: JournalEntryId,
    body: string,
  ) => Result.ResultAsync<JournalEntry, ApiError>;
  /** `DELETE /api/journal-entries/:id`: 記入を削除する */
  deleteJournalEntry: (id: JournalEntryId) => Result.ResultAsync<DeletedJournalEntry, ApiError>;
  /** `GET /api/timeline?before=`: タイムラインの1ページ。`before` を省けば最新のページ */
  getTimeline: (before?: Date) => Result.ResultAsync<TimelinePage, ApiError>;
}> => {
  const request = requestApi(fetchApi);
  return {
    getCurrentSession: () => request("/api/session/current", SessionSnapshotJsonSchema),
    startSession: (id) => request("/api/session", SessionSnapshotJsonSchema, postJson({ id })),
    operateSession: (id, kind) =>
      request("/api/session/commands", SessionSnapshotJsonSchema, postJson({ id, kind })),
    writeJournalEntry: (id, body) =>
      request("/api/journal-entries", JournalEntryJsonSchema, postJson({ id, body })),
    editJournalEntry: (id, body) =>
      request(`/api/journal-entries/${id}`, JournalEntryJsonSchema, sendJson("PATCH", { body })),
    deleteJournalEntry: (id) =>
      request(`/api/journal-entries/${id}`, DeletedJournalEntryJsonSchema, { method: "DELETE" }),
    getTimeline: (before) =>
      request(
        before === undefined
          ? "/api/timeline"
          : `/api/timeline?${new URLSearchParams({ before: before.toISOString() }).toString()}`,
        TimelinePageJsonSchema,
      ),
  };
};
