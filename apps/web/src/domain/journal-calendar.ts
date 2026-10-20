import * as v from "valibot";
import { JournalEntry, JournalEntryJsonSchema, type JournalEntryJson } from "./journal-entry.ts";
import {
  Calendar,
  LocalDateJsonSchema,
  LocalDateKeySchema,
  localDateIn,
  TimeZoneSchema,
  type LocalDate,
} from "./local-date.ts";

/** ジャーナルのカレンダー（GLOSSARY）に出す月 */
export type JournalMonth = Readonly<{ year: number; month: number }>;

/** 1日の記入の数。今日より後の日は、まだ来ていない日として分ける */
export type JournalCalendarDay =
  | Readonly<{ kind: "Day"; date: LocalDate; entries: number }>
  | Readonly<{ kind: "Upcoming"; date: LocalDate }>;

/**
 * ジャーナルのカレンダー（GLOSSARY、`GET /api/journal-calendar` の応答）。
 * `days` はその月の1日から末日まで。画面はこれを月曜始まりの週に並べる
 */
export type JournalCalendar = Readonly<{
  month: JournalMonth;
  today: LocalDate;
  days: ReadonlyArray<JournalCalendarDay>;
}>;

/** 選んだ日の記入（`GET /api/journal-entries/by-date` の応答）。書いた順 */
export type EntriesOnDate = Readonly<{ date: LocalDate; entries: ReadonlyArray<JournalEntry> }>;

/**
 * 記入を書いた時刻の範囲。`from` を含み `until` を含まない。
 *
 * 端末のタイムゾーンでの日付は、UTC との差が -12〜+14 時間なので、UTC の暦でその前後1日まで
 * 広げて読めば必ず含まれる。読んだあとで、端末のタイムゾーンでの日付で絞る。
 */
type WrittenWindow = Readonly<{ from: Date; until: Date }>;

const DAY_MS = 86_400_000;

/** 日付 `first` から `last` までの記入を含む範囲（前後1日ずつ広げる） */
const windowOf = (first: LocalDate, last: LocalDate): WrittenWindow => ({
  from: new Date((Calendar.dayNumberOf(first) - 1) * DAY_MS),
  until: new Date((Calendar.dayNumberOf(last) + 2) * DAY_MS),
});

const lastOfMonth = (month: JournalMonth): LocalDate =>
  Calendar.dateOfDayNumber(
    Calendar.dayNumberOf(Calendar.firstOfMonth(month.year, month.month)) +
      Calendar.daysInMonth(month.year, month.month) -
      1,
  );

export const JournalCalendar = {
  /** 月 `month` の記入をすべて含む、読む範囲 */
  windowOfMonth: (month: JournalMonth): WrittenWindow =>
    windowOf(Calendar.firstOfMonth(month.year, month.month), lastOfMonth(month)),

  /** 日 `date` の記入をすべて含む、読む範囲 */
  windowOfDate: (date: LocalDate): WrittenWindow => windowOf(date, date),

  /**
   * 月 `month` の日ごとの記入の数を数える（GLOSSARY「ジャーナルのカレンダー」）。
   *
   * `writtenAts` は削除していない記入を書いた時刻で、月の外のものが混じっていてもよい。
   * 記入は書いた時刻の、タイムゾーン `timeZone`（端末のタイムゾーン）での日付に数える。
   */
  of: (
    input: Readonly<{
      month: JournalMonth;
      writtenAts: ReadonlyArray<Date>;
      now: Date;
      timeZone: string;
    }>,
  ): JournalCalendar => {
    const dateOf = localDateIn(input.timeZone);
    const today = dateOf(input.now);
    const counts = new Map<string, number>();
    for (const writtenAt of input.writtenAts) {
      const { key } = dateOf(writtenAt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const first = Calendar.dayNumberOf(Calendar.firstOfMonth(input.month.year, input.month.month));
    return {
      month: input.month,
      today,
      days: Array.from(
        { length: Calendar.daysInMonth(input.month.year, input.month.month) },
        (_, i): JournalCalendarDay => {
          const date = Calendar.dateOfDayNumber(first + i);
          return date.key > today.key
            ? { kind: "Upcoming", date }
            : { kind: "Day", date, entries: counts.get(date.key) ?? 0 };
        },
      ),
    };
  },

  /**
   * 記入 `entries` のうち、タイムゾーン `timeZone` で日付 `date` に書いたものを、書いた順に並べる。
   * `entries` は日付の前後のものが混じっていてもよい（`windowOfDate` で読んだもの）
   */
  entriesOn: (
    input: Readonly<{
      date: LocalDate;
      entries: ReadonlyArray<JournalEntry>;
      timeZone: string;
    }>,
  ): EntriesOnDate => {
    const dateOf = localDateIn(input.timeZone);
    return {
      date: input.date,
      entries: input.entries
        .filter((entry) => dateOf(entry.writtenAt).key === input.date.key)
        .toSorted((a, b) => a.writtenAt.getTime() - b.writtenAt.getTime()),
    };
  },

  /** 前の月・次の月 */
  monthBefore: (month: JournalMonth): JournalMonth =>
    month.month === 1
      ? { year: month.year - 1, month: 12 }
      : { year: month.year, month: month.month - 1 },

  monthAfter: (month: JournalMonth): JournalMonth =>
    month.month === 12
      ? { year: month.year + 1, month: 1 }
      : { year: month.year, month: month.month + 1 },

  /** API のクエリに書く月（`2026-10`） */
  keyOfMonth: (month: JournalMonth): string =>
    `${String(month.year).padStart(4, "0")}-${String(month.month).padStart(2, "0")}`,

  /** 応答に使う JSON にできる形。記入の本文は応答の中でだけ取り出す（ADR 0010） */
  entriesOnDateToJson: (found: EntriesOnDate): EntriesOnDateJson => ({
    date: found.date,
    entries: found.entries.map(JournalEntry.toJson),
  }),
} as const;

// ---------------------------------------------------------------------------
// API の入力と応答（ADR 0009）
// ---------------------------------------------------------------------------

/** `YYYY-MM` と書いた月 */
const MonthKeySchema = v.pipe(
  v.string(),
  v.regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  v.transform((key): JournalMonth => ({
    year: Number(key.slice(0, 4)),
    month: Number(key.slice(5, 7)),
  })),
);

/** `GET /api/journal-calendar?month=&timeZone=` のクエリ */
export const JournalCalendarQuerySchema = v.object({
  month: MonthKeySchema,
  timeZone: TimeZoneSchema,
});

/** `GET /api/journal-entries/by-date?date=&timeZone=` のクエリ */
export const EntriesOnDateQuerySchema = v.object({
  date: LocalDateKeySchema,
  timeZone: TimeZoneSchema,
});

const JournalMonthJsonSchema = v.object({
  year: v.pipe(v.number(), v.integer()),
  month: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12)),
});

export const JournalCalendarJsonSchema: v.GenericSchema<unknown, JournalCalendar> = v.object({
  month: JournalMonthJsonSchema,
  today: LocalDateJsonSchema,
  days: v.array(
    v.variant("kind", [
      v.object({
        kind: v.literal("Day"),
        date: LocalDateJsonSchema,
        entries: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
      v.object({ kind: v.literal("Upcoming"), date: LocalDateJsonSchema }),
    ]),
  ),
});

/** JSON にした選んだ日の記入。記入の本文を取り出してある（ADR 0010） */
export type EntriesOnDateJson = Readonly<{
  date: LocalDate;
  entries: ReadonlyArray<JournalEntryJson>;
}>;

export const EntriesOnDateJsonSchema: v.GenericSchema<unknown, EntriesOnDate> = v.object({
  date: LocalDateJsonSchema,
  entries: v.array(JournalEntryJsonSchema),
});

// ---------------------------------------------------------------------------
// ワークフローが使う読み書きの契約
// ---------------------------------------------------------------------------

/** 範囲 `window` に書いた、削除していない記入の書いた時刻を読む */
export type FindEntryTimesWrittenIn = (window: WrittenWindow) => ReadonlyArray<Date>;

/** 範囲 `window` に書いた、削除していない記入を読む */
export type FindJournalEntriesWrittenIn = (window: WrittenWindow) => ReadonlyArray<JournalEntry>;
