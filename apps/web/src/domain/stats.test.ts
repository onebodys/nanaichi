import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { goldenCases, type Plain } from "../testing/golden.ts";
import { localDate, sessionFields, sessionOf, type SessionSpec } from "../testing/golden-values.ts";
import type { WrittenDuring } from "./journal-entry.ts";
import { schemaResult } from "./schema-result.ts";
import { SessionId } from "./session.ts";
import {
  CompactStats,
  Stats,
  StatsQuerySchema,
  StatsReportJsonSchema,
  type CalendarDay,
  type EntryMark,
  type StatsActivity,
  type StatsPeriod,
  type StatsReport,
} from "./stats.ts";
import { TagName } from "./tag.ts";

const TOKYO = "Asia/Tokyo";

/** 日本時間の 2026年 `month`月`day`日 `hour`:`minute` */
const tokyo = (month: number, day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, month - 1, day, hour - 9, minute));

const plusMinutes = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000);

// 2026-10-14 は水曜日
const WEDNESDAY_NOON = tokyo(10, 14, 12);
const TODAY_KEY = "2026-10-14";

// ---------------------------------------------------------------------------
// 場面の入力
// ---------------------------------------------------------------------------

/**
 * 番号 `n` のセッションが `startedAt` に始まり、1ラウンドの中で `sets` セットを完了してから
 * ジャーナルの途中で終了した。セット k の集中は、開始から (k - 1) × 8 + 7 分で終わる
 */
const completed = (n: number, startedAt: Date, sets: number): SessionSpec => ({
  n,
  startedAt,
  operations: [{ kind: "End", at: plusMinutes(startedAt, (sets - 1) * 8 + 7.5) }],
});

/** `startedAt` に始め、集中の途中（3分）で中断してから終了した（不成立セットが1つ） */
const aborted = (n: number, startedAt: Date): SessionSpec => ({
  n,
  startedAt,
  operations: [
    { kind: "Abort", at: plusMinutes(startedAt, 3) },
    { kind: "End", at: plusMinutes(startedAt, 4) },
  ],
});

const running = (n: number, startedAt: Date): SessionSpec => ({ n, startedAt });

const entryOf = (
  owner: SessionSpec,
  writtenAt: Date,
  writtenDuring: WrittenDuring,
  tags: ReadonlyArray<string> = [],
): EntryMark => ({
  sessionId: v.parse(SessionId.schema, sessionFields(owner).id),
  writtenAt,
  writtenDuring,
  tags: tags.map((tag) => v.parse(TagName.schema, tag)),
});

const statsOf = (
  sessions: ReadonlyArray<SessionSpec>,
  period: StatsPeriod,
  now: Date,
  options: Readonly<{ entries?: ReadonlyArray<EntryMark>; timeZone?: string }> = {},
) => ({
  records: { sessions: sessions.map(sessionOf), entries: options.entries ?? [] },
  period,
  now,
  timeZone: options.timeZone ?? TOKYO,
});

// ---------------------------------------------------------------------------
// 期待する出力
// ---------------------------------------------------------------------------

/** `first`（年・月・日）から `length` 日分の日ごと。`todayKey` より後の日はまだ来ていない日 */
const daysFrom = (
  first: readonly [number, number, number],
  length: number,
  todayKey: string,
  counts: Readonly<Record<string, number>>,
): ReadonlyArray<Plain<CalendarDay>> =>
  Array.from({ length }, (_, i) => {
    const day = new Date(Date.UTC(first[0], first[1] - 1, first[2] + i));
    const date = localDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
    return date.key > todayKey
      ? { kind: "Upcoming", date }
      : { kind: "Day", date, completedSets: counts[date.key] ?? 0 };
  });

/** この12週間の日ごと。今日（2026-10-14）の週が最後で、月曜（2026-07-27）から数えて84日 */
const calendarOctober = (counts: Readonly<Record<string, number>>) =>
  daysFrom([2026, 7, 27], 84, TODAY_KEY, counts);

/** 0時台から23時台までの完了セット数。`counts` は時 → 数 */
const hoursOf = (counts: Readonly<Record<number, number>>): ReadonlyArray<number> =>
  Array.from({ length: 24 }, (_, hour) => counts[hour] ?? 0);

type Report = Plain<StatsReport>;
type Active = Extract<Plain<StatsActivity>, { kind: "Active" }>;

/** 記録のある期間の中身。書かなかった項目は、記入・不成立セット・タグ・比べる前の完了セットが 0 */
const active = (
  fields: Pick<Active, "completedSets" | "hours"> & Partial<Active>,
): Plain<StatsActivity> => ({
  kind: "Active",
  abortedSets: 0,
  comparison: { kind: "Compared", previousCompletedSets: 0 },
  entries: 0,
  completedSetsWithEntry: 0,
  trend: { kind: "None" },
  tags: [],
  ...fields,
});

const NO_ACTIVITY: Plain<StatsActivity> = { kind: "NoActivity" };

const todayReport = (
  activity: Plain<StatsActivity>,
  streak: Report["streak"],
  counts: Readonly<Record<string, number>>,
): Report => ({
  serverTime: WEDNESDAY_NOON,
  period: "Today",
  today: localDate(2026, 10, 14),
  range: { from: localDate(2026, 10, 14), to: localDate(2026, 10, 14) },
  activity,
  streak,
  calendar: calendarOctober(counts),
});

const weekReport = (
  activity: Plain<StatsActivity>,
  streak: Report["streak"],
  counts: Readonly<Record<string, number>>,
): Report => ({
  serverTime: WEDNESDAY_NOON,
  period: "Week",
  today: localDate(2026, 10, 14),
  range: { from: localDate(2026, 10, 12), to: localDate(2026, 10, 18) },
  activity,
  streak,
  calendar: calendarOctober(counts),
});

/** 今週（10/12 から 10/18）の日ごとの集中 */
const weekTrend = (counts: Readonly<Record<string, number>>) =>
  ({ kind: "Days", days: daysFrom([2026, 10, 12], 7, TODAY_KEY, counts) }) as const;

goldenCases("Stats.of", Stats.of, [
  {
    // 前日の 23:50 に始めたセッションは、1セット目を 23:57 に、2セット目を今日の 0:05 に終える
    name: "今日の完了セットは、集中を終えた時刻が今日のものを数える",
    input: statsOf(
      [completed(1, tokyo(10, 13, 23, 50), 2), completed(2, tokyo(10, 14, 9), 3)],
      "Today",
      WEDNESDAY_NOON,
    ),
    expected: todayReport(
      active({ completedSets: 4, hours: hoursOf({ 0: 1, 9: 3 }) }),
      { current: 2, longest: 2 },
      { "2026-10-13": 1, "2026-10-14": 4 },
    ),
  },
  {
    // 日本時間の 10/14 8:00 は UTC では 10/13 23:00
    name: "日付は端末のタイムゾーンで区切る（日本時間では今日の完了セット）",
    input: statsOf([completed(1, tokyo(10, 14, 8), 1)], "Today", WEDNESDAY_NOON),
    expected: todayReport(
      active({ completedSets: 1, hours: hoursOf({ 8: 1 }) }),
      { current: 1, longest: 1 },
      { "2026-10-14": 1 },
    ),
  },
  {
    name: "日付は端末のタイムゾーンで区切る（UTC では昨日の完了セットで、今日は記録なし）",
    input: statsOf([completed(1, tokyo(10, 14, 8), 1)], "Today", WEDNESDAY_NOON, {
      timeZone: "UTC",
    }),
    expected: todayReport(NO_ACTIVITY, { current: 1, longest: 1 }, { "2026-10-13": 1 }),
  },
  {
    // 11:40 に始め、12:00 の時点では 11:47 と 11:55 に集中を終えている
    name: "進行中のセッションは、今の時刻までに完了したセットを数える",
    input: statsOf([running(1, tokyo(10, 14, 11, 40))], "Today", WEDNESDAY_NOON),
    expected: todayReport(
      active({ completedSets: 2, hours: hoursOf({ 11: 2 }) }),
      { current: 1, longest: 1 },
      { "2026-10-14": 2 },
    ),
  },
  {
    name: "中断したセットは不成立セットとして完了率のもとに数える",
    input: statsOf(
      [completed(1, tokyo(10, 14, 9), 3), aborted(2, tokyo(10, 14, 10))],
      "Today",
      WEDNESDAY_NOON,
    ),
    expected: todayReport(
      active({ completedSets: 3, abortedSets: 1, hours: hoursOf({ 9: 3 }) }),
      { current: 1, longest: 1 },
      { "2026-10-14": 3 },
    ),
  },
  (() => {
    const session = completed(1, tokyo(10, 14, 9), 3);
    return {
      name: "記入率は、紐付く記入がある完了セットを数え、休憩中の記入は数えない",
      input: statsOf([session], "Today", WEDNESDAY_NOON, {
        entries: [
          entryOf(session, tokyo(10, 14, 9, 7), { kind: "Journal", round: 1, setNumber: 1 }),
          entryOf(session, tokyo(10, 14, 9, 8), { kind: "Journal", round: 1, setNumber: 1 }),
          entryOf(session, tokyo(10, 14, 9, 20), { kind: "Focus", round: 1, setNumber: 3 }),
          entryOf(session, tokyo(10, 14, 9, 25), { kind: "Break", round: 1 }),
        ],
      }),
      expected: todayReport(
        active({
          completedSets: 3,
          entries: 4,
          completedSetsWithEntry: 2,
          hours: hoursOf({ 9: 3 }),
        }),
        { current: 1, longest: 1 },
        { "2026-10-14": 3 },
      ),
    };
  })(),
  (() => {
    const session = completed(1, tokyo(10, 14, 9), 3);
    const journal = (setNumber: number): WrittenDuring => ({
      kind: "Journal",
      round: 1,
      setNumber,
    });
    return {
      name: "タグごとに、そのタグのついた記入がある完了セットを多い順に数える",
      input: statsOf([session], "Today", WEDNESDAY_NOON, {
        entries: [
          entryOf(session, tokyo(10, 14, 9, 7), journal(1), ["読書"]),
          entryOf(session, tokyo(10, 14, 9, 8), journal(1), ["読書", "仕事"]),
          entryOf(session, tokyo(10, 14, 9, 15), journal(2), ["仕事"]),
          entryOf(session, tokyo(10, 14, 9, 23), journal(3), ["仕事"]),
        ],
      }),
      expected: todayReport(
        active({
          completedSets: 3,
          entries: 4,
          completedSetsWithEntry: 3,
          tags: [
            { name: "仕事", completedSets: 3 },
            { name: "読書", completedSets: 1 },
          ],
          hours: hoursOf({ 9: 3 }),
        }),
        { current: 1, longest: 1 },
        { "2026-10-14": 3 },
      ),
    };
  })(),
  {
    // 9:57 と 10:05 に集中を終える
    name: "時間帯は、集中を終えた時刻の時で数える",
    input: statsOf([completed(1, tokyo(10, 14, 9, 50), 2)], "Today", WEDNESDAY_NOON),
    expected: todayReport(
      active({ completedSets: 2, hours: hoursOf({ 9: 1, 10: 1 }) }),
      { current: 1, longest: 1 },
      { "2026-10-14": 2 },
    ),
  },
  {
    name: "期間の中に完了セットも不成立セットも記入もなければ、記録なしになる",
    input: statsOf([completed(1, tokyo(10, 13, 9), 1)], "Today", WEDNESDAY_NOON),
    expected: todayReport(NO_ACTIVITY, { current: 1, longest: 1 }, { "2026-10-13": 1 }),
  },
  {
    name: "週は月曜に始まり、日ごとの集中にまだ来ていない日も並べる",
    input: statsOf(
      [completed(1, tokyo(10, 12, 9), 2), completed(2, tokyo(10, 14, 9), 1)],
      "Week",
      WEDNESDAY_NOON,
    ),
    expected: weekReport(
      active({
        completedSets: 3,
        trend: weekTrend({ "2026-10-12": 2, "2026-10-14": 1 }),
        hours: hoursOf({ 9: 3 }),
      }),
      { current: 1, longest: 1 },
      { "2026-10-12": 2, "2026-10-14": 1 },
    ),
  },
  {
    name: "月はその月の1日から末日まで",
    input: statsOf([completed(1, tokyo(10, 1, 9), 1)], "Month", WEDNESDAY_NOON),
    expected: {
      serverTime: WEDNESDAY_NOON,
      period: "Month",
      today: localDate(2026, 10, 14),
      range: { from: localDate(2026, 10, 1), to: localDate(2026, 10, 31) },
      activity: active({
        completedSets: 1,
        trend: {
          kind: "Days",
          days: daysFrom([2026, 10, 1], 31, TODAY_KEY, { "2026-10-01": 1 }),
        },
        hours: hoursOf({ 9: 1 }),
      }),
      streak: { current: 0, longest: 1 },
      calendar: calendarOctober({ "2026-10-01": 1 }),
    },
  },
  {
    name: "すべては最初のセッションの日から今日までで、月ごとに数える",
    input: statsOf(
      [completed(1, tokyo(8, 20, 9), 2), completed(2, tokyo(10, 14, 9), 1)],
      "All",
      WEDNESDAY_NOON,
    ),
    expected: {
      serverTime: WEDNESDAY_NOON,
      period: "All",
      today: localDate(2026, 10, 14),
      range: { from: localDate(2026, 8, 20), to: localDate(2026, 10, 14) },
      activity: active({
        completedSets: 3,
        comparison: { kind: "NotCompared" },
        trend: {
          kind: "Months",
          months: [
            { year: 2026, month: 8, completedSets: 2 },
            { year: 2026, month: 9, completedSets: 0 },
            { year: 2026, month: 10, completedSets: 1 },
          ],
        },
        hours: hoursOf({ 9: 3 }),
      }),
      streak: { current: 1, longest: 1 },
      calendar: calendarOctober({ "2026-08-20": 2, "2026-10-14": 1 }),
    },
  },
  {
    name: "今日は日ごとの集中を出さない",
    input: statsOf([completed(1, tokyo(10, 14, 9), 1)], "Today", WEDNESDAY_NOON),
    expected: todayReport(
      active({ completedSets: 1, trend: { kind: "None" }, hours: hoursOf({ 9: 1 }) }),
      { current: 1, longest: 1 },
      { "2026-10-14": 1 },
    ),
  },
  {
    // 昨日の今の時刻（12:00）より後の完了セットは比べない
    name: "今日は、昨日の同じ時刻までの完了セットと比べる",
    input: statsOf(
      [
        completed(1, tokyo(10, 13, 9), 3),
        completed(2, tokyo(10, 13, 15), 2),
        completed(3, tokyo(10, 14, 9), 1),
      ],
      "Today",
      WEDNESDAY_NOON,
    ),
    expected: todayReport(
      active({
        completedSets: 1,
        comparison: { kind: "Compared", previousCompletedSets: 3 },
        hours: hoursOf({ 9: 1 }),
      }),
      { current: 2, longest: 2 },
      { "2026-10-13": 5, "2026-10-14": 1 },
    ),
  },
  {
    // 先週の月曜と水曜の朝は比べる。水曜の夜と木曜は比べない
    name: "週は、先週の同じ曜日の同じ時刻までと比べる",
    input: statsOf(
      [
        completed(1, tokyo(10, 5, 9), 1),
        completed(2, tokyo(10, 7, 9), 2),
        completed(3, tokyo(10, 7, 20), 3),
        completed(4, tokyo(10, 8, 9), 3),
        completed(5, tokyo(10, 14, 9), 1),
      ],
      "Week",
      WEDNESDAY_NOON,
    ),
    expected: weekReport(
      active({
        completedSets: 1,
        comparison: { kind: "Compared", previousCompletedSets: 3 },
        trend: weekTrend({ "2026-10-14": 1 }),
        hours: hoursOf({ 9: 1 }),
      }),
      { current: 1, longest: 2 },
      { "2026-10-05": 1, "2026-10-07": 5, "2026-10-08": 3, "2026-10-14": 1 },
    ),
  },
  {
    name: "月は、先月の同じ日の同じ時刻までと比べ、先月のほうが短ければ先月を丸ごと比べる",
    input: statsOf(
      [
        completed(1, tokyo(2, 27, 9), 1),
        completed(2, tokyo(2, 28, 20), 2),
        completed(3, tokyo(3, 31, 9), 1),
      ],
      "Month",
      tokyo(3, 31, 12),
    ),
    expected: {
      serverTime: tokyo(3, 31, 12),
      period: "Month",
      today: localDate(2026, 3, 31),
      range: { from: localDate(2026, 3, 1), to: localDate(2026, 3, 31) },
      activity: active({
        completedSets: 1,
        comparison: { kind: "Compared", previousCompletedSets: 3 },
        trend: {
          kind: "Days",
          days: daysFrom([2026, 3, 1], 31, "2026-03-31", { "2026-03-31": 1 }),
        },
        hours: hoursOf({ 9: 1 }),
      }),
      streak: { current: 1, longest: 2 },
      // 2026-03-31 は火曜日。今週の月曜（3/30）から11週前の月曜（1/12）から数える
      calendar: daysFrom([2026, 1, 12], 84, "2026-03-31", {
        "2026-02-27": 1,
        "2026-02-28": 2,
        "2026-03-31": 1,
      }),
    },
  },
  {
    name: "今日まで完了セットのある日が続いた日数と、これまでの最長を数える",
    input: statsOf(
      [
        ...[1, 2, 3, 4].map((day) => completed(day, tokyo(10, day, 9), 1)),
        ...[12, 13, 14].map((day) => completed(day, tokyo(10, day, 9), 1)),
      ],
      "Today",
      WEDNESDAY_NOON,
    ),
    expected: todayReport(
      active({
        completedSets: 1,
        comparison: { kind: "Compared", previousCompletedSets: 1 },
        hours: hoursOf({ 9: 1 }),
      }),
      { current: 3, longest: 4 },
      {
        "2026-10-01": 1,
        "2026-10-02": 1,
        "2026-10-03": 1,
        "2026-10-04": 1,
        "2026-10-12": 1,
        "2026-10-13": 1,
        "2026-10-14": 1,
      },
    ),
  },
  {
    name: "今日まだ完了セットがなければ、昨日までで数える",
    input: statsOf(
      [12, 13].map((day) => completed(day, tokyo(10, day, 9), 1)),
      "Today",
      WEDNESDAY_NOON,
    ),
    expected: todayReport(
      NO_ACTIVITY,
      { current: 2, longest: 2 },
      { "2026-10-12": 1, "2026-10-13": 1 },
    ),
  },
  {
    name: "昨日も今日も完了セットがなければ、0日になる",
    input: statsOf([completed(1, tokyo(10, 11, 9), 1)], "Today", WEDNESDAY_NOON),
    expected: todayReport(NO_ACTIVITY, { current: 0, longest: 1 }, { "2026-10-11": 1 }),
  },
  {
    name: "不成立セットだけの日は続いた日に数えない",
    input: statsOf(
      [completed(1, tokyo(10, 12, 9), 1), aborted(2, tokyo(10, 13, 9))],
      "Today",
      WEDNESDAY_NOON,
    ),
    expected: todayReport(NO_ACTIVITY, { current: 0, longest: 1 }, { "2026-10-12": 1 }),
  },
  {
    name: "今週を最後に、月曜始まりの12週を古い順に並べ、まだ来ていない日を分ける",
    input: statsOf([completed(1, tokyo(10, 14, 9), 2)], "Week", WEDNESDAY_NOON),
    expected: weekReport(
      active({
        completedSets: 2,
        trend: weekTrend({ "2026-10-14": 2 }),
        hours: hoursOf({ 9: 2 }),
      }),
      { current: 1, longest: 1 },
      { "2026-10-14": 2 },
    ),
  },
  {
    name: "記録がまったくなければ、記録なしになる",
    input: statsOf([], "Today", WEDNESDAY_NOON),
    expected: todayReport(NO_ACTIVITY, { current: 0, longest: 0 }, {}),
  },
]);

/** 期待する出力に書いた素の値のスタッツを、ワークフローに渡す型（ブランド付きのタグ）にする */
const reportOf = (report: Report): StatsReport => ({
  ...report,
  activity:
    report.activity.kind === "NoActivity"
      ? report.activity
      : {
          ...report.activity,
          tags: report.activity.tags.map(({ name, completedSets }) => ({
            name: v.parse(TagName.schema, name),
            completedSets,
          })),
        },
});

goldenCases(
  "Stats.completedSetsOf",
  (input: { report: StatsReport }) => Stats.completedSetsOf(input.report),
  [
    {
      name: "期間 Today のスタッツの完了セット数を返す",
      input: {
        report: reportOf(
          todayReport(
            active({ completedSets: 4, hours: hoursOf({ 0: 1, 9: 3 }) }),
            { current: 2, longest: 2 },
            {},
          ),
        ),
      },
      expected: 4,
    },
    {
      name: "期間の中に記録がなければ、完了セットは 0",
      input: { report: reportOf(todayReport(NO_ACTIVITY, { current: 0, longest: 0 }, {})) },
      expected: 0,
    },
  ],
);

type CompactReport = Plain<ReturnType<typeof CompactStats.of>>;

goldenCases("CompactStats.of", (input: { report: StatsReport }) => CompactStats.of(input.report), [
  {
    name: "日付は YYYY-MM-DD の文字列で、まだ来ていない日と完了セットのない時間帯は入らない",
    input: {
      report: reportOf(
        weekReport(
          active({
            completedSets: 2,
            trend: weekTrend({ "2026-10-13": 2 }),
            hours: hoursOf({ 9: 2 }),
          }),
          { current: 1, longest: 1 },
          { "2026-10-13": 2 },
        ),
      ),
    },
    expected: {
      period: "Week",
      today: "2026-10-14",
      range: { from: "2026-10-12", to: "2026-10-18" },
      activity: {
        kind: "Active",
        completedSets: 2,
        abortedSets: 0,
        comparison: { kind: "Compared", previousCompletedSets: 0 },
        entries: 0,
        completedSetsWithEntry: 0,
        trend: {
          kind: "Days",
          days: [
            { date: "2026-10-12", completedSets: 0 },
            { date: "2026-10-13", completedSets: 2 },
            { date: "2026-10-14", completedSets: 0 },
          ],
        },
        tags: [],
        hours: [{ hour: 9, completedSets: 2 }],
      },
      streak: { current: 1, longest: 1 },
    } satisfies CompactReport,
  },
  {
    name: "すべての期間の月ごとは YYYY-MM の文字列で並ぶ",
    input: {
      report: reportOf({
        serverTime: WEDNESDAY_NOON,
        period: "All",
        today: localDate(2026, 10, 14),
        range: { from: localDate(2026, 9, 30), to: localDate(2026, 10, 14) },
        activity: active({
          completedSets: 4,
          comparison: { kind: "NotCompared" },
          trend: {
            kind: "Months",
            months: [
              { year: 2026, month: 9, completedSets: 1 },
              { year: 2026, month: 10, completedSets: 3 },
            ],
          },
          hours: hoursOf({ 9: 4 }),
        }),
        streak: { current: 1, longest: 1 },
        calendar: calendarOctober({ "2026-09-30": 1, "2026-10-14": 3 }),
      }),
    },
    expected: {
      period: "All",
      today: "2026-10-14",
      range: { from: "2026-09-30", to: "2026-10-14" },
      activity: {
        kind: "Active",
        completedSets: 4,
        abortedSets: 0,
        comparison: { kind: "NotCompared" },
        entries: 0,
        completedSetsWithEntry: 0,
        trend: {
          kind: "Months",
          months: [
            { month: "2026-09", completedSets: 1 },
            { month: "2026-10", completedSets: 3 },
          ],
        },
        tags: [],
        hours: [{ hour: 9, completedSets: 4 }],
      },
      streak: { current: 1, longest: 1 },
    } satisfies CompactReport,
  },
  {
    name: "期間の中に記録がなければ、記録がないことだけを返す",
    input: {
      report: reportOf(todayReport(NO_ACTIVITY, { current: 0, longest: 0 }, {})),
    },
    expected: {
      period: "Today",
      today: "2026-10-14",
      range: { from: "2026-10-14", to: "2026-10-14" },
      activity: { kind: "NoActivity" },
      streak: { current: 0, longest: 0 },
    } satisfies CompactReport,
  },
]);

goldenCases(
  "CompactStats.withCalendarOf",
  (input: { report: StatsReport }) => CompactStats.withCalendarOf(input.report),
  [
    {
      // 11週前の月曜（2026-07-27）から今日（水曜）まで 11 × 7 + 3 日
      name: "この12週間の日ごとを求めると、今日までの日を古い順に入れる",
      input: {
        report: reportOf(
          todayReport(
            active({ completedSets: 2, hours: hoursOf({ 9: 2 }) }),
            { current: 1, longest: 1 },
            { "2026-10-14": 2 },
          ),
        ),
      },
      expected: {
        period: "Today",
        today: "2026-10-14",
        range: { from: "2026-10-14", to: "2026-10-14" },
        activity: {
          kind: "Active",
          completedSets: 2,
          abortedSets: 0,
          comparison: { kind: "Compared", previousCompletedSets: 0 },
          entries: 0,
          completedSetsWithEntry: 0,
          trend: { kind: "None" },
          tags: [],
          hours: [{ hour: 9, completedSets: 2 }],
        },
        streak: { current: 1, longest: 1 },
        calendar: daysFrom([2026, 7, 27], 11 * 7 + 3, TODAY_KEY, { "2026-10-14": 2 }).flatMap(
          (day) =>
            day.kind === "Day" ? [{ date: day.date.key, completedSets: day.completedSets }] : [],
        ),
      },
    },
  ],
);

describe("API の入力と応答", () => {
  test("タイムゾーンでない値はクエリとして受け付けない", () => {
    const parse = schemaResult(StatsQuerySchema);

    expect(Result.isSuccess(parse({ period: "Week", timeZone: TOKYO }))).toBe(true);
    expect(Result.isFailure(parse({ period: "Week", timeZone: "Mars/Olympus" }))).toBe(true);
    expect(Result.isFailure(parse({ period: "Year", timeZone: TOKYO }))).toBe(true);
  });

  test("JSON にしたスタッツを検証すると元に戻る", () => {
    const session = completed(1, tokyo(10, 14, 9), 2);
    const report = Stats.of(
      statsOf([session], "All", WEDNESDAY_NOON, {
        entries: [
          entryOf(session, tokyo(10, 14, 9, 7), { kind: "Journal", round: 1, setNumber: 1 }, [
            "読書",
          ]),
        ],
      }),
    );

    const parsed = schemaResult(StatsReportJsonSchema)(JSON.parse(JSON.stringify(report)));

    expect(Result.isSuccess(parsed) && parsed.value).toEqual(report);
  });
});
