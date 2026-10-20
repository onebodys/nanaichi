import * as v from "valibot";
import type { JournalEntry, JournalEntryJson } from "./journal-entry.ts";
import {
  Calendar,
  LocalDateKeySchema,
  localTimeIn,
  startOfDayIn,
  TimeZoneSchema,
  type LocalDate,
} from "./local-date.ts";

/**
 * 1回に読める期間の日数の上限。1年分の振り返りまでは1回で読め、誤って何年分も読んで
 * 応答が大きくなりすぎるのを防ぐ
 */
export const JOURNAL_PERIOD_MAX_DAYS = 366;

/**
 * ジャーナル記入を読む期間（GLOSSARY「MCP サーバー」）。`from` と `to` の日付を両端とも含み、
 * 日付はタイムゾーン `timeZone` で区切る（スタッツと同じ考え方、ADR 0014）
 */
export type JournalPeriod = Readonly<{ from: LocalDate; to: LocalDate; timeZone: string }>;

/** 期間の時刻の範囲。`since` 以後で `until` より前に書いた記入が期間に入る */
type WrittenRange = Readonly<{ since: Date; until: Date }>;

/** 期間に書いた記入を、書いた日付と時刻（期間のタイムゾーン）とともに並べたもの */
type JournalPeriodEntry = JournalEntry &
  Readonly<{
    /** 書いた日付（`YYYY-MM-DD`） */
    writtenOn: string;
    /** 書いた時刻（`HH:MM`）。AI が読んで日ごと・時間帯ごとにまとめやすいよう、時刻もタイムゾーンで出す */
    writtenAtLocalTime: string;
  }>;

export type JournalPeriodReport = Readonly<{
  period: JournalPeriod;
  /** 書いた順（古い順） */
  entries: ReadonlyArray<JournalPeriodEntry>;
}>;

/** JSON にした期間の記入。本文は応答の中でだけ取り出す（`JournalEntry.toJson` と同じ） */
export type JournalPeriodReportJson = Readonly<{
  period: Readonly<{ from: string; to: string; timeZone: string }>;
  entries: ReadonlyArray<
    JournalEntryJson & Readonly<{ writtenOn: string; writtenAtLocalTime: string }>
  >;
}>;

/** 期間の指定（MCP のツールの引数）。日付は `YYYY-MM-DD` */
export const JournalPeriodQuerySchema: v.GenericSchema<unknown, JournalPeriod> = v.pipe(
  v.object({ from: LocalDateKeySchema, to: LocalDateKeySchema, timeZone: TimeZoneSchema }),
  v.check(({ from, to }) => from.key <= to.key, "from が to より後の日付"),
  v.check(
    ({ from, to }) =>
      Calendar.dayNumberOf(to) - Calendar.dayNumberOf(from) < JOURNAL_PERIOD_MAX_DAYS,
    `期間が ${JOURNAL_PERIOD_MAX_DAYS} 日より長い`,
  ),
);

const pad2 = (value: number): string => String(value).padStart(2, "0");

export const JournalPeriod = {
  /** 期間の時刻の範囲。`from` の日の 0:00 から、`to` の翌日の 0:00 の手前まで */
  rangeOf: (period: JournalPeriod): WrittenRange => {
    const startOf = startOfDayIn(period.timeZone);
    return {
      since: startOf(period.from),
      until: startOf(Calendar.dateOfDayNumber(Calendar.dayNumberOf(period.to) + 1)),
    };
  },

  /** 期間に書いた記入（書いた順）に、書いた日付と時刻を添える */
  report: (period: JournalPeriod, entries: ReadonlyArray<JournalEntry>): JournalPeriodReport => {
    const timeOf = localTimeIn(period.timeZone);
    return {
      period,
      entries: entries.map((entry) => {
        const { date, minuteOfDay } = timeOf(entry.writtenAt);
        return {
          ...entry,
          writtenOn: date.key,
          writtenAtLocalTime: `${pad2(Math.floor(minuteOfDay / 60))}:${pad2(minuteOfDay % 60)}`,
        };
      }),
    };
  },

  toJson: (report: JournalPeriodReport): JournalPeriodReportJson => ({
    period: {
      from: report.period.from.key,
      to: report.period.to.key,
      timeZone: report.period.timeZone,
    },
    entries: report.entries.map((entry) => ({ ...entry, body: entry.body.unwrap() })),
  }),
} as const;

// ---------------------------------------------------------------------------
// ワークフローが使う読み書きの契約（kamae: 概念の隣に置き、1つの契約に1つの操作）
// ---------------------------------------------------------------------------

/** `range` の間に書いた、削除していない記入を書いた順に読む */
export type FindJournalEntriesWritten = (range: WrittenRange) => ReadonlyArray<JournalEntry>;
