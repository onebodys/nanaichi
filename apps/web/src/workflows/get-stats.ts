import { Result } from "@praha/byethrow";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import {
  Stats,
  StatsQuerySchema,
  type FindStatsRecords,
  type StatsReport,
} from "../domain/stats.ts";
import { loadOpenSession, type OpenSessionDeps } from "./auto-end-session.ts";

export type GetStatsError = ValidationError;

export type GetStatsDeps = OpenSessionDeps & Readonly<{ findStatsRecords: FindStatsRecords }>;

const parseQuery = schemaResult(StatsQuerySchema);

/**
 * スタッツを返す（GLOSSARY の「スタッツ」、ADR 0014）。
 *
 * クエリ（期間と端末のタイムゾーン）の検証 → 自動終了の時刻を過ぎたセッションを閉じる →
 * すべての記録を読む → 期間とタイムゾーンで数える。
 */
export const getStats =
  (deps: GetStatsDeps) =>
  (rawQuery: unknown, now: Date): Result.Result<StatsReport, GetStatsError> =>
    Result.pipe(
      parseQuery(rawQuery),
      Result.andThrough(() => Result.succeed(loadOpenSession(deps)(now))),
      Result.map(({ period, timeZone }) =>
        Stats.of({ records: deps.findStatsRecords(), period, now, timeZone }),
      ),
    );
