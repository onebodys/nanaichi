import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Result } from "@praha/byethrow";
import { AdvanceModeJsonSchema } from "../domain/advance-mode.ts";
import { ApiErrorBodyJsonSchema } from "../domain/api-error.ts";
import { schemaResult } from "../domain/schema-result.ts";
import { DeletedJournalEntryJsonSchema, JournalEntryJsonSchema } from "../domain/journal-entry.ts";
import {
  EntriesOnDateJsonSchema,
  JournalCalendar,
  JournalCalendarJsonSchema,
} from "../domain/journal-calendar.ts";
import { SessionSnapshotJsonSchema } from "../domain/session.ts";
import { StatsReportJsonSchema } from "../domain/stats.ts";
import { DeletedTagJsonSchema, TagListJsonSchema, TagUsageListJsonSchema } from "../domain/tag.ts";
import { TaggedEntriesPageJsonSchema } from "../domain/tagged-entries.ts";
import { TimelinePageJsonSchema } from "../domain/timeline.ts";
import type { Backend, BackendError } from "./backend.ts";
import { connectSync, openBrowserSocket, type OpenSyncSocket } from "./sync-connection.ts";

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

type ReceivedResponse = Readonly<{ ok: boolean; body: unknown }>;

const send =
  (fetchApi: Fetch) =>
  (path: string, init: RequestInit | undefined): Result.ResultAsync<Response, BackendError> =>
    Result.try({
      try: () => fetchApi(path, init),
      catch: (): BackendError => ({ kind: "Unreachable" }),
    });

const receive = (response: Response): Result.ResultAsync<ReceivedResponse, BackendError> =>
  Result.try({
    try: async () => {
      const body: unknown = await response.json();
      return { ok: response.ok, body };
    },
    catch: (): BackendError => ({ kind: "Broken" }),
  });

const parseErrorBody = schemaResult(ApiErrorBodyJsonSchema);

const decode =
  <T>(schema: StandardSchemaV1<unknown, T>) =>
  (response: ReceivedResponse): Result.Result<T, BackendError> => {
    const unexpected: BackendError = { kind: "Broken" };

    if (response.ok) {
      return Result.pipe(
        schemaResult(schema)(response.body),
        Result.mapError(() => unexpected),
      );
    }
    return Result.pipe(
      parseErrorBody(response.body),
      Result.mapError(() => unexpected),
      Result.andThen((body): Result.Result<never, BackendError> =>
        Result.fail({ kind: "Rejected", code: body.error }),
      ),
    );
  };

const requestApi =
  (fetchApi: Fetch, onSignedOut: () => void) =>
  <T>(
    path: string,
    schema: StandardSchemaV1<unknown, T>,
    init?: RequestInit,
  ): Result.ResultAsync<T, BackendError> =>
    Result.pipe(
      send(fetchApi)(path, init),
      Result.andThen(receive),
      Result.andThen(decode(schema)),
      Result.inspectError((error) => {
        if (error.kind === "Rejected" && error.code === "UNAUTHENTICATED") {
          onSignedOut();
        }
      }),
    );

const sendJson = (method: "POST" | "PATCH" | "PUT" | "DELETE", body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const postJson = (body: unknown): RequestInit => sendJson("POST", body);

export type RemoteBackendDeps = Readonly<{
  fetchApi?: Fetch;
  openSocket?: OpenSyncSocket;
  /** ログインが切れていた（`UNAUTHENTICATED`）とき、失敗を返す前に呼ぶ */
  onSignedOut: () => void;
}>;

/** 同期の WebSocket の URL。SPA と API は同じ origin なので、ログインの cookie はそのまま送られる */
const syncUrl = (): string => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/ws`;
};

/**
 * SPA と API は同じ origin なので、ログインの cookie はそのまま送られる。
 */
export const createRemoteBackend = ({
  fetchApi = (path, init) => fetch(path, init),
  openSocket,
  onSignedOut,
}: RemoteBackendDeps): Backend => {
  const request = requestApi(fetchApi, onSignedOut);
  return {
    getCurrentSession: () => request("/api/session/current", SessionSnapshotJsonSchema),
    startSession: (id) => request("/api/session", SessionSnapshotJsonSchema, postJson({ id })),
    operateSession: (id, kind) =>
      request("/api/session/commands", SessionSnapshotJsonSchema, postJson({ id, kind })),
    writeJournalEntry: (id, body, tags) =>
      request("/api/journal-entries", JournalEntryJsonSchema, postJson({ id, body, tags })),
    editJournalEntry: (id, body, tags) =>
      request(
        `/api/journal-entries/${id}`,
        JournalEntryJsonSchema,
        sendJson("PATCH", { body, tags }),
      ),
    deleteJournalEntry: (id) =>
      request(`/api/journal-entries/${id}`, DeletedJournalEntryJsonSchema, { method: "DELETE" }),
    getTimeline: (before) =>
      request(
        before === undefined
          ? "/api/timeline"
          : `/api/timeline?${new URLSearchParams({ before: before.toISOString() }).toString()}`,
        TimelinePageJsonSchema,
      ),
    getTags: () => request("/api/tags", TagListJsonSchema),
    getTagUsage: () => request("/api/tags/usage", TagUsageListJsonSchema),
    deleteTag: (name, deletion) =>
      request(
        `/api/tags/${encodeURIComponent(name)}`,
        DeletedTagJsonSchema,
        sendJson("DELETE", deletion),
      ),
    getStats: (period, timeZone) =>
      request(
        `/api/stats?${new URLSearchParams({ period, timeZone }).toString()}`,
        StatsReportJsonSchema,
      ),
    getJournalCalendar: (month, timeZone) =>
      request(
        `/api/journal-calendar?${new URLSearchParams({ month: JournalCalendar.keyOfMonth(month), timeZone }).toString()}`,
        JournalCalendarJsonSchema,
      ),
    getEntriesOnDate: (date, timeZone) =>
      request(
        `/api/journal-entries/by-date?${new URLSearchParams({ date: date.key, timeZone }).toString()}`,
        EntriesOnDateJsonSchema,
      ),
    getEntriesWithTag: (tag, before) =>
      request(
        `/api/journal-entries/by-tag?${new URLSearchParams(
          before === undefined ? { tag } : { tag, before: before.toISOString() },
        ).toString()}`,
        TaggedEntriesPageJsonSchema,
      ),
    getAdvanceMode: () => request("/api/settings/advance-mode", AdvanceModeJsonSchema),
    changeAdvanceMode: (mode) =>
      request("/api/settings/advance-mode", AdvanceModeJsonSchema, sendJson("PUT", mode)),
    subscribe: (handlers) => connectSync(handlers, openSocket ?? openBrowserSocket(syncUrl())),
  };
};
