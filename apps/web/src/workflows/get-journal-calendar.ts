import { Result } from "@praha/byethrow";
import {
  JournalCalendar,
  JournalCalendarQuerySchema,
  type FindEntryTimesWrittenIn,
} from "../domain/journal-calendar.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";

export type GetJournalCalendarError = ValidationError;

export type GetJournalCalendarDeps = Readonly<{ findEntryTimesWrittenIn: FindEntryTimesWrittenIn }>;

const parseQuery = schemaResult(JournalCalendarQuerySchema);

/**
 * ジャーナルのカレンダー（GLOSSARY）の1か月分を返す。
 *
 * クエリ（月と端末のタイムゾーン）の検証 → その月の記入を書いた時刻を読む → 端末のタイムゾーンの日付ごとに数える。
 */
export const getJournalCalendar =
  (deps: GetJournalCalendarDeps) =>
  (rawQuery: unknown, now: Date): Result.Result<JournalCalendar, GetJournalCalendarError> =>
    Result.pipe(
      parseQuery(rawQuery),
      Result.map(({ month, timeZone }) =>
        JournalCalendar.of({
          month,
          writtenAts: deps.findEntryTimesWrittenIn(JournalCalendar.windowOfMonth(month)),
          now,
          timeZone,
        }),
      ),
    );
