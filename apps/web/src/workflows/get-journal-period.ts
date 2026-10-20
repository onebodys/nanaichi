import { Result } from "@praha/byethrow";
import type { FindJournalEntriesWrittenIn } from "../domain/journal-calendar.ts";
import {
  JournalPeriod,
  JournalPeriodQuerySchema,
  type JournalPeriodReport,
} from "../domain/journal-period.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";

export type GetJournalPeriodError = ValidationError;

export type GetJournalPeriodDeps = Readonly<{
  findJournalEntriesWrittenIn: FindJournalEntriesWrittenIn;
}>;

const parseQuery = schemaResult(JournalPeriodQuerySchema);

/**
 * 期間に書いたジャーナル記入を返す（GLOSSARY「MCP サーバー」）。
 *
 * 期間の検証 → 期間を時刻の範囲にする → その範囲に書いた記入を読む → 書いた日付と時刻を添える。
 * 記入を読むだけで自動終了には関わらないので、セッションは閉じない。
 */
export const getJournalPeriod =
  (deps: GetJournalPeriodDeps) =>
  (rawQuery: unknown): Result.Result<JournalPeriodReport, GetJournalPeriodError> =>
    Result.pipe(
      parseQuery(rawQuery),
      Result.map((period) =>
        JournalPeriod.report(
          period,
          deps.findJournalEntriesWrittenIn(JournalPeriod.rangeOf(period)),
        ),
      ),
    );
