import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { JsonDateSchema } from "../domain/json-date.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import {
  Timeline,
  TIMELINE_PAGE_SIZE,
  type FindTimelineSessions,
  type TimelinePage,
  type TimelineRange,
} from "../domain/timeline.ts";
import { loadOpenSession, type OpenSessionDeps } from "./auto-end-session.ts";

/**
 * `GET /api/timeline?before=` のクエリ。`before` は前のページの `next.before`（ISO 8601）。
 * 省けば最新のページになる。
 */
const TimelineQuerySchema = v.pipe(
  v.object({ before: v.optional(JsonDateSchema) }),
  v.transform(({ before }): TimelineRange =>
    // 次のページがあるかを見分けるため、1件多く読む（`Timeline.page`）
    before === undefined
      ? { kind: "Latest", limit: TIMELINE_PAGE_SIZE + 1 }
      : { kind: "Before", before, limit: TIMELINE_PAGE_SIZE + 1 },
  ),
);

export type GetTimelineError = ValidationError;

export type GetTimelineDeps = OpenSessionDeps &
  Readonly<{ findTimelineSessions: FindTimelineSessions }>;

const parseQuery = schemaResult(TimelineQuerySchema);

/**
 * タイムラインの1ページを返す（GLOSSARY の「タイムライン」、ADR 0011）。
 *
 * クエリの検証 → 自動終了の時刻を過ぎたセッションを閉じる → 新しい順にセッションと記入を読む → ページにする。
 * 日付の区切りと完了セット数は端末のタイムゾーンで決まるので、画面が組み立てる。
 */
export const getTimeline =
  (deps: GetTimelineDeps) =>
  (rawQuery: unknown, now: Date): Result.Result<TimelinePage, GetTimelineError> =>
    Result.pipe(
      parseQuery(rawQuery),
      Result.andThrough(() => Result.succeed(loadOpenSession(deps)(now))),
      Result.map((range) =>
        Timeline.page(deps.findTimelineSessions(range), TIMELINE_PAGE_SIZE, now),
      ),
    );
