import { Result } from "@praha/byethrow";
import {
  EntriesOnDateQuerySchema,
  JournalCalendar,
  type EntriesOnDate,
  type FindJournalEntriesWrittenIn,
} from "../domain/journal-calendar.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";

export type GetEntriesOnDateError = ValidationError;

export type GetEntriesOnDateDeps = Readonly<{
  findJournalEntriesWrittenIn: FindJournalEntriesWrittenIn;
}>;

const parseQuery = schemaResult(EntriesOnDateQuerySchema);

/**
 * ジャーナルのカレンダー（GLOSSARY）で選んだ日の記入を返す。
 *
 * クエリ（日付と端末のタイムゾーン）の検証 → その日の前後の記入を読む → 端末のタイムゾーンでその日に書いたものに絞る。
 */
export const getEntriesOnDate =
  (deps: GetEntriesOnDateDeps) =>
  (rawQuery: unknown): Result.Result<EntriesOnDate, GetEntriesOnDateError> =>
    Result.pipe(
      parseQuery(rawQuery),
      Result.map(({ date, timeZone }) =>
        JournalCalendar.entriesOn({
          date,
          entries: deps.findJournalEntriesWrittenIn(JournalCalendar.windowOfDate(date)),
          timeZone,
        }),
      ),
    );
