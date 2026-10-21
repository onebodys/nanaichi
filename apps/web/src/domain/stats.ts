import * as v from "valibot";
import type { JournalEntry } from "./journal-entry.ts";
import { JsonDateSchema } from "./json-date.ts";
import {
  Calendar,
  LocalDateJsonSchema,
  localTimeIn,
  TimeZoneSchema,
  type LocalDate,
  type LocalTime,
} from "./local-date.ts";
import { Session, type SessionId } from "./session.ts";
import { TagName } from "./tag.ts";

/** スタッツ（GLOSSARY）の期間。週は月曜に始まる */
export const STATS_PERIODS = ["Today", "Week", "Month", "All"] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

/** この12週間の集中に並べる日数 */
const CALENDAR_WEEKS = 12;

/** タグごとの完了セットに出すタグの数 */
const TOP_TAGS = 5;

/** スタッツを数えるのに使う記入。本文は使わないので持たない */
export type EntryMark = Pick<JournalEntry, "sessionId" | "writtenAt" | "writtenDuring" | "tags">;

/** スタッツを数えるもとの記録。すべてのセッションと、削除していない記入 */
export type StatsRecords = Readonly<{
  sessions: ReadonlyArray<Session>;
  entries: ReadonlyArray<EntryMark>;
}>;

/** 1日の完了セット数。今日より後の日は、まだ来ていない日として分ける */
export type CalendarDay =
  | Readonly<{ kind: "Day"; date: LocalDate; completedSets: number }>
  | Readonly<{ kind: "Upcoming"; date: LocalDate }>;

export type MonthCount = Readonly<{ year: number; month: number; completedSets: number }>;

/** 日ごとの集中。今日は1日しかないので出さず、すべては月ごとにする */
export type StatsTrend =
  | Readonly<{ kind: "None" }>
  | Readonly<{ kind: "Days"; days: ReadonlyArray<CalendarDay> }>
  | Readonly<{ kind: "Months"; months: ReadonlyArray<MonthCount> }>;

/** 前の期間の同じ時点までの完了セット数。すべての期間には前の期間がない */
type StatsComparison =
  | Readonly<{ kind: "Compared"; previousCompletedSets: number }>
  | Readonly<{ kind: "NotCompared" }>;

export type TagCount = Readonly<{ name: TagName; completedSets: number }>;

/** 期間の中の記録。完了セットも不成立セットも記入もなければ `NoActivity` */
export type StatsActivity =
  | Readonly<{ kind: "NoActivity" }>
  | Readonly<{
      kind: "Active";
      completedSets: number;
      abortedSets: number;
      comparison: StatsComparison;
      entries: number;
      /** 記入率（GLOSSARY）の分子。紐付く記入がある完了セットの数 */
      completedSetsWithEntry: number;
      trend: StatsTrend;
      /** 多い順に `TOP_TAGS` まで */
      tags: ReadonlyArray<TagCount>;
      /** 0時台から23時台までの完了セット数（集中を終えた時刻で数える） */
      hours: ReadonlyArray<number>;
    }>;

/**
 * スタッツ（GLOSSARY、`GET /api/stats` の応答、ADR 0014）。
 *
 * - `range`: 期間の最初と最後の日付。すべてなら最初のセッションの日から今日まで
 * - `streak`・`calendar`: 期間に関わらず、今日までの記録から数える
 */
export type StatsReport = Readonly<{
  serverTime: Date;
  period: StatsPeriod;
  today: LocalDate;
  range: Readonly<{ from: LocalDate; to: LocalDate }>;
  activity: StatsActivity;
  streak: Readonly<{ current: number; longest: number }>;
  /** この12週間の日ごと。月曜始まりの週を古い順に並べ、週の中も月曜から */
  calendar: ReadonlyArray<CalendarDay>;
}>;

// ---------------------------------------------------------------------------
// 数えるもとにする出来事
// ---------------------------------------------------------------------------

/** 完了セット・不成立セット・記入を、端末のタイムゾーンでの日付と時刻に置いたもの */
type Happening = Readonly<{ dayNumber: number; minuteOfDay: number; hour: number }>;

type CompletedSetAt = Happening & Readonly<{ setKey: string }>;

type Happenings = Readonly<{
  completed: ReadonlyArray<CompletedSetAt>;
  aborted: ReadonlyArray<Happening>;
  entries: ReadonlyArray<Happening>;
  /** セットごとの、紐付く記入についたタグ（記入のないセットは入らない） */
  tagsBySet: ReadonlyMap<string, ReadonlySet<TagName>>;
  firstDayNumber: number | undefined;
}>;

const setKeyOf = (sessionId: SessionId, round: number, setNumber: number): string =>
  `${sessionId}:${round}:${setNumber}`;

/** 記入が紐付くセット。休憩中の記入はどのセットにも紐付かない（GLOSSARY「ジャーナル記入」） */
const setKeyOfEntry = (entry: EntryMark): string | undefined => {
  switch (entry.writtenDuring.kind) {
    case "Focus":
    case "Journal":
    case "Idle":
      return setKeyOf(entry.sessionId, entry.writtenDuring.round, entry.writtenDuring.setNumber);
    case "Break":
      return undefined;
  }
};

const happeningOf = (local: LocalTime): Happening => ({
  dayNumber: Calendar.dayNumberOf(local.date),
  minuteOfDay: local.minuteOfDay,
  hour: Math.floor(local.minuteOfDay / 60),
});

const happeningsOf = (records: StatsRecords, now: Date, timeZone: string): Happenings => {
  const localOf = localTimeIn(timeZone);
  const at = (time: Date) => happeningOf(localOf(time));

  const outcomes = records.sessions.flatMap((session) =>
    Session.setOutcomesAt(session, now).map((outcome) => ({ session, outcome })),
  );

  const tagsBySet = new Map<string, Set<TagName>>();
  for (const entry of records.entries) {
    const key = setKeyOfEntry(entry);
    if (key !== undefined) {
      const tags = tagsBySet.get(key) ?? new Set<TagName>();
      entry.tags.forEach((tag) => tags.add(tag));
      tagsBySet.set(key, tags);
    }
  }

  const startDays = records.sessions.map((session) => at(session.events[0].at).dayNumber);

  return {
    completed: outcomes
      .filter(({ outcome }) => outcome.kind === "CompletedSet")
      .map(({ session, outcome }) => ({
        ...at(outcome.at),
        setKey: setKeyOf(session.id, outcome.round, outcome.setNumber),
      })),
    aborted: outcomes
      .filter(({ outcome }) => outcome.kind === "AbortedSet")
      .map(({ outcome }) => at(outcome.at)),
    entries: records.entries.filter((entry) => entry.writtenAt <= now).map((e) => at(e.writtenAt)),
    tagsBySet,
    firstDayNumber: startDays.length === 0 ? undefined : Math.min(...startDays),
  };
};

// ---------------------------------------------------------------------------
// 期間
// ---------------------------------------------------------------------------

/** 期間。日付は `dayNumber`（両端を含む） */
type DayRange = Readonly<{ from: number; to: number }>;

/**
 * 前の期間の同じ時点まで。`fullDays` 日目までは丸ごと、その次の日は `untilMinute` 分までを含む。
 * 前の期間がその日まで届かなければ（先月のほうが短いとき）、前の期間を丸ごと含む
 */
type PreviousRange = Readonly<{ from: number; to: number; fullDays: number; untilMinute: number }>;

const rangeOf = (
  period: StatsPeriod,
  today: LocalDate,
  firstDayNumber: number | undefined,
): DayRange => {
  const todayNumber = Calendar.dayNumberOf(today);
  switch (period) {
    case "Today":
      return { from: todayNumber, to: todayNumber };
    case "Week": {
      const monday = todayNumber - Calendar.weekdayOf(today);
      return { from: monday, to: monday + 6 };
    }
    case "Month": {
      const first = Calendar.dayNumberOf(Calendar.firstOfMonth(today.year, today.month));
      return { from: first, to: first + Calendar.daysInMonth(today.year, today.month) - 1 };
    }
    case "All":
      return { from: Math.min(firstDayNumber ?? todayNumber, todayNumber), to: todayNumber };
  }
};

const previousRangeOf = (
  period: StatsPeriod,
  today: LocalDate,
  range: DayRange,
  minuteOfDay: number,
): PreviousRange | undefined => {
  const offset = Calendar.dayNumberOf(today) - range.from;
  switch (period) {
    case "Today":
    case "Week": {
      const length = range.to - range.from + 1;
      return {
        from: range.from - length,
        to: range.from - 1,
        fullDays: offset,
        untilMinute: minuteOfDay,
      };
    }
    case "Month": {
      const previousYear = today.month === 1 ? today.year - 1 : today.year;
      const previousMonth = today.month === 1 ? 12 : today.month - 1;
      const from = Calendar.dayNumberOf(Calendar.firstOfMonth(previousYear, previousMonth));
      return {
        from,
        to: range.from - 1,
        fullDays: offset,
        untilMinute: minuteOfDay,
      };
    }
    case "All":
      return undefined;
  }
};

const isIn = (range: DayRange) => (happening: Happening) =>
  happening.dayNumber >= range.from && happening.dayNumber <= range.to;

const isUpToSamePoint = (previous: PreviousRange) => (happening: Happening) => {
  if (happening.dayNumber < previous.from || happening.dayNumber > previous.to) {
    return false;
  }
  const index = happening.dayNumber - previous.from;
  return (
    index < previous.fullDays ||
    (index === previous.fullDays && happening.minuteOfDay <= previous.untilMinute)
  );
};

// ---------------------------------------------------------------------------
// 数える
// ---------------------------------------------------------------------------

const countByDay = (happenings: ReadonlyArray<Happening>): ReadonlyMap<number, number> => {
  const counts = new Map<number, number>();
  for (const { dayNumber } of happenings) {
    counts.set(dayNumber, (counts.get(dayNumber) ?? 0) + 1);
  }
  return counts;
};

const calendarDaysOf = (
  range: DayRange,
  todayNumber: number,
  counts: ReadonlyMap<number, number>,
): ReadonlyArray<CalendarDay> =>
  Array.from({ length: range.to - range.from + 1 }, (_, i): CalendarDay => {
    const dayNumber = range.from + i;
    const date = Calendar.dateOfDayNumber(dayNumber);
    return dayNumber > todayNumber
      ? { kind: "Upcoming", date }
      : { kind: "Day", date, completedSets: counts.get(dayNumber) ?? 0 };
  });

const monthsOf = (
  range: DayRange,
  completed: ReadonlyArray<Happening>,
): ReadonlyArray<MonthCount> => {
  const first = Calendar.dateOfDayNumber(range.from);
  const last = Calendar.dateOfDayNumber(range.to);
  const length = (last.year - first.year) * 12 + (last.month - first.month) + 1;
  const indexOf = (date: LocalDate) => (date.year - first.year) * 12 + (date.month - first.month);
  const counts = Array.from({ length }, () => 0);
  for (const { dayNumber } of completed) {
    const index = indexOf(Calendar.dateOfDayNumber(dayNumber));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts.map((completedSets, index) => {
    const month0 = first.month - 1 + index;
    return { year: first.year + Math.floor(month0 / 12), month: (month0 % 12) + 1, completedSets };
  });
};

const trendOf = (
  period: StatsPeriod,
  range: DayRange,
  todayNumber: number,
  completed: ReadonlyArray<Happening>,
): StatsTrend => {
  switch (period) {
    case "Today":
      return { kind: "None" };
    case "Week":
    case "Month":
      return { kind: "Days", days: calendarDaysOf(range, todayNumber, countByDay(completed)) };
    case "All":
      return { kind: "Months", months: monthsOf(range, completed) };
  }
};

const tagsOf = (
  completed: ReadonlyArray<CompletedSetAt>,
  tagsBySet: ReadonlyMap<string, ReadonlySet<TagName>>,
): ReadonlyArray<TagCount> => {
  const counts = new Map<TagName, number>();
  for (const { setKey } of completed) {
    for (const tag of tagsBySet.get(setKey) ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([name, completedSets]) => ({ name, completedSets }))
    .toSorted((a, b) => b.completedSets - a.completedSets || a.name.localeCompare(b.name))
    .slice(0, TOP_TAGS);
};

const hoursOf = (completed: ReadonlyArray<Happening>): ReadonlyArray<number> => {
  const counts = Array.from({ length: 24 }, () => 0);
  for (const { hour } of completed) {
    counts[hour] = (counts[hour] ?? 0) + 1;
  }
  return counts;
};

/**
 * 連続日数（GLOSSARY）。今日まだ完了セットがなければ昨日から数える。
 * 最長は、これまでの記録の中で完了セットのある日がいちばん長く続いた日数
 */
const streakOf = (
  days: ReadonlySet<number>,
  todayNumber: number,
): Readonly<{ current: number; longest: number }> => {
  const countBackFrom = (start: number) => {
    let count = 0;
    while (days.has(start - count)) {
      count += 1;
    }
    return count;
  };
  const current = countBackFrom(days.has(todayNumber) ? todayNumber : todayNumber - 1);
  const longest = [...days]
    .filter((day) => !days.has(day + 1))
    .reduce((max, last) => Math.max(max, countBackFrom(last)), 0);
  return { current, longest };
};

export const Stats = {
  /**
   * 時刻 `now` までの記録から、期間 `period` のスタッツを数える（GLOSSARY「スタッツ」、ADR 0014）。
   *
   * - 日付と時間帯はタイムゾーン `timeZone`（端末のタイムゾーン）で区切る
   * - 完了セットは集中を終えた時刻、不成立セットは中断・終了した時刻、記入は書いた時刻の日付に数える
   * - 進行中のセッションは `now` までに完了したものを数える
   * - 集中時間は、前の期間の同じ時点まで（何日目の何時何分まで）と比べる
   */
  of: (
    input: Readonly<{
      records: StatsRecords;
      period: StatsPeriod;
      now: Date;
      timeZone: string;
    }>,
  ): StatsReport => {
    const nowLocal = localTimeIn(input.timeZone)(input.now);
    const today = nowLocal.date;
    const todayNumber = Calendar.dayNumberOf(today);
    const happenings = happeningsOf(input.records, input.now, input.timeZone);
    const range = rangeOf(input.period, today, happenings.firstDayNumber);
    const inRange = isIn(range);

    const completed = happenings.completed.filter(inRange);
    const aborted = happenings.aborted.filter(inRange);
    const entries = happenings.entries.filter(inRange);
    const previous = previousRangeOf(input.period, today, range, nowLocal.minuteOfDay);

    const monday = todayNumber - Calendar.weekdayOf(today);
    const calendarRange = { from: monday - (CALENDAR_WEEKS - 1) * 7, to: monday + 6 };

    return {
      serverTime: input.now,
      period: input.period,
      today,
      range: { from: Calendar.dateOfDayNumber(range.from), to: Calendar.dateOfDayNumber(range.to) },
      activity:
        completed.length + aborted.length + entries.length === 0
          ? { kind: "NoActivity" }
          : {
              kind: "Active",
              completedSets: completed.length,
              abortedSets: aborted.length,
              comparison:
                previous === undefined
                  ? { kind: "NotCompared" }
                  : {
                      kind: "Compared",
                      previousCompletedSets: happenings.completed.filter(isUpToSamePoint(previous))
                        .length,
                    },
              entries: entries.length,
              completedSetsWithEntry: completed.filter(({ setKey }) =>
                happenings.tagsBySet.has(setKey),
              ).length,
              trend: trendOf(input.period, range, todayNumber, completed),
              tags: tagsOf(completed, happenings.tagsBySet),
              hours: hoursOf(completed),
            },
      streak: streakOf(
        new Set(happenings.completed.map(({ dayNumber }) => dayNumber)),
        todayNumber,
      ),
      calendar: calendarDaysOf(calendarRange, todayNumber, countByDay(happenings.completed)),
    };
  },

  /** 期間 `Today` のスタッツから、今日の完了セット数。ヘッダーの今日の集中時間のもと */
  completedSetsOf: (report: StatsReport): number =>
    report.activity.kind === "Active" ? report.activity.completedSets : 0,
} as const;

// ---------------------------------------------------------------------------
// API の入力と応答（ADR 0009）
// ---------------------------------------------------------------------------

/** `GET /api/stats?period=&timeZone=` のクエリ */
export const StatsQuerySchema = v.object({
  period: v.picklist(STATS_PERIODS),
  timeZone: TimeZoneSchema,
});

const count = v.pipe(v.number(), v.integer(), v.minValue(0));

const CalendarDayJsonSchema = v.variant("kind", [
  v.object({ kind: v.literal("Day"), date: LocalDateJsonSchema, completedSets: count }),
  v.object({ kind: v.literal("Upcoming"), date: LocalDateJsonSchema }),
]);

export const StatsReportJsonSchema: v.GenericSchema<unknown, StatsReport> = v.object({
  serverTime: JsonDateSchema,
  period: v.picklist(STATS_PERIODS),
  today: LocalDateJsonSchema,
  range: v.object({ from: LocalDateJsonSchema, to: LocalDateJsonSchema }),
  activity: v.variant("kind", [
    v.object({ kind: v.literal("NoActivity") }),
    v.object({
      kind: v.literal("Active"),
      completedSets: count,
      abortedSets: count,
      comparison: v.variant("kind", [
        v.object({ kind: v.literal("Compared"), previousCompletedSets: count }),
        v.object({ kind: v.literal("NotCompared") }),
      ]),
      entries: count,
      completedSetsWithEntry: count,
      trend: v.variant("kind", [
        v.object({ kind: v.literal("None") }),
        v.object({ kind: v.literal("Days"), days: v.array(CalendarDayJsonSchema) }),
        v.object({
          kind: v.literal("Months"),
          months: v.array(
            v.object({
              year: v.pipe(v.number(), v.integer()),
              month: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12)),
              completedSets: count,
            }),
          ),
        }),
      ]),
      tags: v.array(v.object({ name: TagName.schema, completedSets: count })),
      hours: v.pipe(v.array(count), v.length(24)),
    }),
  ]),
  streak: v.object({ current: count, longest: count }),
  calendar: v.array(CalendarDayJsonSchema),
});

// ---------------------------------------------------------------------------
// ワークフローが使う読み書きの契約
// ---------------------------------------------------------------------------

/** スタッツを数えるもとの記録を読む。すべてのセッションと、削除していない記入（本文を除く） */
export type FindStatsRecords = () => StatsRecords;

// ---------------------------------------------------------------------------
// MCP サーバーに返す形（Issue #89）
// ---------------------------------------------------------------------------

/** AI が読む1日の完了セット数。日付は `YYYY-MM-DD` */
type CompactDay = Readonly<{ date: string; completedSets: number }>;

/** AI が読む1か月の完了セット数。月は `YYYY-MM` */
type CompactMonth = Readonly<{ month: string; completedSets: number }>;

type CompactTrend =
  | Readonly<{ kind: "None" }>
  | Readonly<{ kind: "Days"; days: ReadonlyArray<CompactDay> }>
  | Readonly<{ kind: "Months"; months: ReadonlyArray<CompactMonth> }>;

type CompactActivity =
  | Readonly<{ kind: "NoActivity" }>
  | Readonly<{
      kind: "Active";
      completedSets: number;
      abortedSets: number;
      comparison: StatsComparison;
      entries: number;
      completedSetsWithEntry: number;
      trend: CompactTrend;
      tags: ReadonlyArray<TagCount>;
      /** 完了セットのある時間帯だけを、0時台から順に */
      hours: ReadonlyArray<Readonly<{ hour: number; completedSets: number }>>;
    }>;

/**
 * MCP の `get_stats` が返すスタッツ。AI の文脈を無駄に使わないよう、`StatsReport` を小さくしたもの。
 *
 * - 日付は `YYYY-MM-DD` の文字列にする
 * - まだ来ていない日と、完了セットのない時間帯は省く
 * - この12週間の日ごとは、求めたとき（`CompactStatsReportWithCalendar`）だけ入れる
 */
export type CompactStatsReport = Readonly<{
  period: StatsPeriod;
  today: string;
  range: Readonly<{ from: string; to: string }>;
  activity: CompactActivity;
  streak: Readonly<{ current: number; longest: number }>;
}>;

export type CompactStatsReportWithCalendar = CompactStatsReport &
  Readonly<{
    /** この12週間の日ごと（今日まで）。古い順 */
    calendar: ReadonlyArray<CompactDay>;
  }>;

const pastDaysOf = (days: ReadonlyArray<CalendarDay>): ReadonlyArray<CompactDay> =>
  days.flatMap((day): ReadonlyArray<CompactDay> => {
    switch (day.kind) {
      case "Day":
        return [{ date: day.date.key, completedSets: day.completedSets }];
      case "Upcoming":
        return [];
    }
  });

const compactTrendOf = (trend: StatsTrend): CompactTrend => {
  switch (trend.kind) {
    case "None":
      return trend;
    case "Days":
      return { kind: "Days", days: pastDaysOf(trend.days) };
    case "Months":
      return {
        kind: "Months",
        months: trend.months.map(({ year, month, completedSets }) => ({
          month: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`,
          completedSets,
        })),
      };
  }
};

const compactActivityOf = (activity: StatsActivity): CompactActivity => {
  switch (activity.kind) {
    case "NoActivity":
      return activity;
    case "Active":
      return {
        ...activity,
        trend: compactTrendOf(activity.trend),
        hours: activity.hours.flatMap((completedSets, hour) =>
          completedSets === 0 ? [] : [{ hour, completedSets }],
        ),
      };
  }
};

export const CompactStats = {
  /** スタッツを、AI が読む小さな形にする。この12週間の日ごとは入れない */
  of: (report: StatsReport): CompactStatsReport => ({
    period: report.period,
    today: report.today.key,
    range: { from: report.range.from.key, to: report.range.to.key },
    activity: compactActivityOf(report.activity),
    streak: report.streak,
  }),

  /** スタッツを、AI が読む小さな形にする。この12週間の日ごと（今日まで）も入れる */
  withCalendarOf: (report: StatsReport): CompactStatsReportWithCalendar => ({
    ...CompactStats.of(report),
    calendar: pastDaysOf(report.calendar),
  }),
} as const;
