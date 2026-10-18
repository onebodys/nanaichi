import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import type { WrittenDuring } from "./journal-entry.ts";
import { schemaResult } from "./schema-result.ts";
import { SessionEventId, type SessionOperation } from "./session-event.ts";
import { SessionId, type Session } from "./session.ts";
import {
  Stats,
  StatsQuerySchema,
  StatsReportJsonSchema,
  type EntryMark,
  type StatsPeriod,
  type StatsRecords,
} from "./stats.ts";
import { TagName } from "./tag.ts";

const TOKYO = "Asia/Tokyo";

/** 日本時間の 2026年 `month`月`day`日 `hour`:`minute` */
const tokyo = (month: number, day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, month - 1, day, hour - 9, minute));

const plusMinutes = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000);

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, "0")}`;

const operation = (kind: SessionOperation["kind"], at: Date) => ({
  kind,
  id: v.parse(SessionEventId.schema, uuid()),
  at,
});

/**
 * `startedAt` に始め、1ラウンドの中で `sets` セットを完了してからジャーナルの途中で終了したセッション。
 * セット n の集中は、開始から (n - 1) × 8 + 7 分で終わる
 */
const sessionWithSets = (startedAt: Date, sets: number): Session => ({
  id: v.parse(SessionId.schema, uuid()),
  events: [
    { kind: "Start", id: v.parse(SessionEventId.schema, uuid()), at: startedAt },
    operation("End", plusMinutes(startedAt, (sets - 1) * 8 + 7.5)),
  ],
  journalEntryTimes: [],
  advanceModeChanges: [],
});

/** `startedAt` に始め、集中の途中で中断してから終了したセッション（不成立セットが1つ） */
const abortedSession = (startedAt: Date): Session => ({
  id: v.parse(SessionId.schema, uuid()),
  events: [
    { kind: "Start", id: v.parse(SessionEventId.schema, uuid()), at: startedAt },
    operation("Abort", plusMinutes(startedAt, 3)),
    operation("End", plusMinutes(startedAt, 4)),
  ],
  journalEntryTimes: [],
  advanceModeChanges: [],
});

const entry = (
  session: Session,
  writtenAt: Date,
  writtenDuring: WrittenDuring = { kind: "Journal", round: 1, setNumber: 1 },
  tags: ReadonlyArray<string> = [],
): EntryMark => ({
  sessionId: session.id,
  writtenAt,
  writtenDuring,
  tags: tags.map((tag) => v.parse(TagName.schema, tag)),
});

const statsOf = (
  records: Partial<StatsRecords>,
  period: StatsPeriod,
  now: Date,
  timeZone = TOKYO,
) =>
  Stats.of({
    records: { sessions: records.sessions ?? [], entries: records.entries ?? [] },
    period,
    now,
    timeZone,
  });

const activeOf = (report: ReturnType<typeof statsOf>) => {
  if (report.activity.kind !== "Active") {
    throw new Error("期間の中に記録がない");
  }
  return report.activity;
};

// 2026-10-14 は水曜日
const WEDNESDAY_NOON = tokyo(10, 14, 12);

describe("期間の中の記録", () => {
  test("今日の完了セットは、集中を終えた時刻が今日のものを数える", () => {
    // 前日の 23:50 に始めたセッションは、1セット目を 23:57 に、2セット目を今日の 0:05 に終える
    const crossing = sessionWithSets(tokyo(10, 13, 23, 50), 2);
    const today = sessionWithSets(tokyo(10, 14, 9), 3);

    const report = statsOf({ sessions: [crossing, today] }, "Today", WEDNESDAY_NOON);

    expect(report.range.from.key).toBe("2026-10-14");
    expect(activeOf(report).completedSets).toBe(4);
    expect(Stats.completedSetsOf(report)).toBe(4);
  });

  test("日付は端末のタイムゾーンで区切る", () => {
    // 日本時間の 10/14 8:00 は UTC では 10/13 23:00
    const session = sessionWithSets(tokyo(10, 14, 8), 1);

    expect(statsOf({ sessions: [session] }, "Today", WEDNESDAY_NOON).activity.kind).toBe("Active");
    expect(statsOf({ sessions: [session] }, "Today", WEDNESDAY_NOON, "UTC").activity.kind).toBe(
      "NoActivity",
    );
  });

  test("進行中のセッションは、今の時刻までに完了したセットを数える", () => {
    const running: Session = {
      id: v.parse(SessionId.schema, uuid()),
      events: [
        { kind: "Start", id: v.parse(SessionEventId.schema, uuid()), at: tokyo(10, 14, 11, 40) },
      ],
      journalEntryTimes: [],
      advanceModeChanges: [],
    };

    // 11:40 に始め、12:00 の時点では 11:47 と 11:55 に集中を終えている
    expect(activeOf(statsOf({ sessions: [running] }, "Today", WEDNESDAY_NOON)).completedSets).toBe(
      2,
    );
  });

  test("中断したセットは不成立セットとして完了率のもとに数える", () => {
    const report = statsOf(
      { sessions: [sessionWithSets(tokyo(10, 14, 9), 3), abortedSession(tokyo(10, 14, 10))] },
      "Today",
      WEDNESDAY_NOON,
    );

    expect(activeOf(report)).toMatchObject({ completedSets: 3, abortedSets: 1 });
  });

  test("記入率は、紐付く記入がある完了セットを数え、休憩中の記入は数えない", () => {
    const session = sessionWithSets(tokyo(10, 14, 9), 3);
    const report = statsOf(
      {
        sessions: [session],
        entries: [
          entry(session, tokyo(10, 14, 9, 7), { kind: "Journal", round: 1, setNumber: 1 }),
          entry(session, tokyo(10, 14, 9, 8), { kind: "Journal", round: 1, setNumber: 1 }),
          entry(session, tokyo(10, 14, 9, 20), { kind: "Focus", round: 1, setNumber: 3 }),
          entry(session, tokyo(10, 14, 9, 25), { kind: "Break", round: 1 }),
        ],
      },
      "Today",
      WEDNESDAY_NOON,
    );

    expect(activeOf(report)).toMatchObject({ entries: 4, completedSetsWithEntry: 2 });
  });

  test("タグごとに、そのタグのついた記入がある完了セットを多い順に数える", () => {
    const session = sessionWithSets(tokyo(10, 14, 9), 3);
    const report = statsOf(
      {
        sessions: [session],
        entries: [
          entry(session, tokyo(10, 14, 9, 7), { kind: "Journal", round: 1, setNumber: 1 }, [
            "読書",
          ]),
          entry(session, tokyo(10, 14, 9, 8), { kind: "Journal", round: 1, setNumber: 1 }, [
            "読書",
            "仕事",
          ]),
          entry(session, tokyo(10, 14, 9, 15), { kind: "Journal", round: 1, setNumber: 2 }, [
            "仕事",
          ]),
          entry(session, tokyo(10, 14, 9, 23), { kind: "Journal", round: 1, setNumber: 3 }, [
            "仕事",
          ]),
        ],
      },
      "Today",
      WEDNESDAY_NOON,
    );

    expect(activeOf(report).tags).toEqual([
      { name: "仕事", completedSets: 3 },
      { name: "読書", completedSets: 1 },
    ]);
  });

  test("時間帯は、集中を終えた時刻の時で数える", () => {
    const report = statsOf(
      { sessions: [sessionWithSets(tokyo(10, 14, 9, 50), 2)] },
      "Today",
      WEDNESDAY_NOON,
    );

    // 9:57 と 10:05 に集中を終える
    const { hours } = activeOf(report);
    expect(hours[9]).toBe(1);
    expect(hours[10]).toBe(1);
    expect(hours.reduce((a, b) => a + b, 0)).toBe(2);
  });

  test("期間の中に完了セットも不成立セットも記入もなければ、記録なしになる", () => {
    const report = statsOf(
      { sessions: [sessionWithSets(tokyo(10, 13, 9), 1)] },
      "Today",
      WEDNESDAY_NOON,
    );

    expect(report.activity).toEqual({ kind: "NoActivity" });
    expect(Stats.completedSetsOf(report)).toBe(0);
  });
});

describe("期間", () => {
  test("週は月曜に始まり、日ごとの集中にまだ来ていない日も並べる", () => {
    const report = statsOf(
      { sessions: [sessionWithSets(tokyo(10, 12, 9), 2), sessionWithSets(tokyo(10, 14, 9), 1)] },
      "Week",
      WEDNESDAY_NOON,
    );

    expect([report.range.from.key, report.range.to.key]).toEqual(["2026-10-12", "2026-10-18"]);
    const { trend } = activeOf(report);
    expect(trend.kind === "Days" && trend.days.map((day) => [day.kind, day.date.day])).toEqual([
      ["Day", 12],
      ["Day", 13],
      ["Day", 14],
      ["Upcoming", 15],
      ["Upcoming", 16],
      ["Upcoming", 17],
      ["Upcoming", 18],
    ]);
    expect(
      trend.kind === "Days" &&
        trend.days.map((day) => (day.kind === "Day" ? day.completedSets : undefined)),
    ).toEqual([2, 0, 1, undefined, undefined, undefined, undefined]);
  });

  test("月はその月の1日から末日まで", () => {
    const report = statsOf(
      { sessions: [sessionWithSets(tokyo(10, 1, 9), 1)] },
      "Month",
      WEDNESDAY_NOON,
    );

    expect([report.range.from.key, report.range.to.key]).toEqual(["2026-10-01", "2026-10-31"]);
    const { trend } = activeOf(report);
    expect(trend.kind === "Days" && trend.days.length).toBe(31);
  });

  test("すべては最初のセッションの日から今日までで、月ごとに数える", () => {
    const report = statsOf(
      { sessions: [sessionWithSets(tokyo(8, 20, 9), 2), sessionWithSets(tokyo(10, 14, 9), 1)] },
      "All",
      WEDNESDAY_NOON,
    );

    expect([report.range.from.key, report.range.to.key]).toEqual(["2026-08-20", "2026-10-14"]);
    const { trend, comparison } = activeOf(report);
    expect(trend).toEqual({
      kind: "Months",
      months: [
        { year: 2026, month: 8, completedSets: 2 },
        { year: 2026, month: 9, completedSets: 0 },
        { year: 2026, month: 10, completedSets: 1 },
      ],
    });
    expect(comparison).toEqual({ kind: "NotCompared" });
  });

  test("今日は日ごとの集中を出さない", () => {
    const report = statsOf(
      { sessions: [sessionWithSets(tokyo(10, 14, 9), 1)] },
      "Today",
      WEDNESDAY_NOON,
    );

    expect(activeOf(report).trend).toEqual({ kind: "None" });
  });
});

describe("前の期間との比べ方", () => {
  test("今日は、昨日の同じ時刻までの完了セットと比べる", () => {
    const report = statsOf(
      {
        sessions: [
          sessionWithSets(tokyo(10, 13, 9), 3),
          // 昨日の今の時刻より後の完了セットは比べない
          sessionWithSets(tokyo(10, 13, 15), 2),
          sessionWithSets(tokyo(10, 14, 9), 1),
        ],
      },
      "Today",
      WEDNESDAY_NOON,
    );

    expect(activeOf(report).comparison).toEqual({ kind: "Compared", previousCompletedSets: 3 });
  });

  test("週は、先週の同じ曜日の同じ時刻までと比べる", () => {
    const report = statsOf(
      {
        sessions: [
          // 先週の月曜と水曜の朝は比べる。水曜の夜と木曜は比べない
          sessionWithSets(tokyo(10, 5, 9), 1),
          sessionWithSets(tokyo(10, 7, 9), 2),
          sessionWithSets(tokyo(10, 7, 20), 3),
          sessionWithSets(tokyo(10, 8, 9), 3),
          sessionWithSets(tokyo(10, 14, 9), 1),
        ],
      },
      "Week",
      WEDNESDAY_NOON,
    );

    expect(activeOf(report).comparison).toEqual({ kind: "Compared", previousCompletedSets: 3 });
  });

  test("月は、先月の同じ日の同じ時刻までと比べ、先月のほうが短ければ先月を丸ごと比べる", () => {
    const report = statsOf(
      {
        sessions: [
          sessionWithSets(tokyo(2, 27, 9), 1),
          sessionWithSets(tokyo(2, 28, 20), 2),
          sessionWithSets(tokyo(3, 31, 9), 1),
        ],
      },
      "Month",
      tokyo(3, 31, 12),
    );

    expect(activeOf(report).comparison).toEqual({ kind: "Compared", previousCompletedSets: 3 });
  });
});

describe("連続日数", () => {
  test("今日まで完了セットのある日が続いた日数と、これまでの最長を数える", () => {
    const sessions = [
      ...[1, 2, 3, 4].map((day) => sessionWithSets(tokyo(10, day, 9), 1)),
      ...[12, 13, 14].map((day) => sessionWithSets(tokyo(10, day, 9), 1)),
    ];

    expect(statsOf({ sessions }, "Today", WEDNESDAY_NOON).streak).toEqual({
      current: 3,
      longest: 4,
    });
  });

  test("今日まだ完了セットがなければ、昨日までで数える", () => {
    const sessions = [12, 13].map((day) => sessionWithSets(tokyo(10, day, 9), 1));

    expect(statsOf({ sessions }, "Today", WEDNESDAY_NOON).streak.current).toBe(2);
  });

  test("昨日も今日も完了セットがなければ、0日になる", () => {
    const sessions = [sessionWithSets(tokyo(10, 11, 9), 1)];

    expect(statsOf({ sessions }, "Today", WEDNESDAY_NOON).streak).toEqual({
      current: 0,
      longest: 1,
    });
  });

  test("不成立セットだけの日は続いた日に数えない", () => {
    const sessions = [sessionWithSets(tokyo(10, 12, 9), 1), abortedSession(tokyo(10, 13, 9))];

    expect(statsOf({ sessions }, "Today", WEDNESDAY_NOON).streak.current).toBe(0);
  });
});

describe("この12週間", () => {
  test("今週を最後に、月曜始まりの12週を古い順に並べ、まだ来ていない日を分ける", () => {
    const report = statsOf(
      { sessions: [sessionWithSets(tokyo(10, 14, 9), 2)] },
      "Week",
      WEDNESDAY_NOON,
    );

    expect(report.calendar).toHaveLength(84);
    expect(report.calendar[0]?.date.key).toBe("2026-07-27");
    expect(report.calendar.at(-1)?.date.key).toBe("2026-10-18");
    expect(report.calendar[79]).toMatchObject({ kind: "Day", completedSets: 2 });
    expect(report.calendar[80]?.kind).toBe("Upcoming");
  });
});

describe("API の入力と応答", () => {
  test("タイムゾーンでない値はクエリとして受け付けない", () => {
    const parse = schemaResult(StatsQuerySchema);

    expect(Result.isSuccess(parse({ period: "Week", timeZone: TOKYO }))).toBe(true);
    expect(Result.isFailure(parse({ period: "Week", timeZone: "Mars/Olympus" }))).toBe(true);
    expect(Result.isFailure(parse({ period: "Year", timeZone: TOKYO }))).toBe(true);
  });

  test("JSON にしたスタッツを検証すると元に戻る", () => {
    const session = sessionWithSets(tokyo(10, 14, 9), 2);
    const report = statsOf(
      {
        sessions: [session],
        entries: [entry(session, tokyo(10, 14, 9, 7), undefined, ["読書"])],
      },
      "All",
      WEDNESDAY_NOON,
    );

    const parsed = schemaResult(StatsReportJsonSchema)(JSON.parse(JSON.stringify(report)));

    expect(Result.isSuccess(parsed) && parsed.value).toEqual(report);
  });
});
