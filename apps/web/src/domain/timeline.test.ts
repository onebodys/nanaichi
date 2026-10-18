import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import {
  JournalEntryBody,
  JournalEntryId,
  type JournalEntry,
  type WrittenDuring,
} from "./journal-entry.ts";
import { schemaResult } from "./schema-result.ts";
import { SessionEventId } from "./session-event.ts";
import { SessionId, type Session } from "./session.ts";
import {
  Timeline,
  TimelinePageJsonSchema,
  type TimelineCursor,
  type TimelineDay,
  type TimelineSession,
} from "./timeline.ts";

// 2026-10-17 23:30（日本時間）= 2026-10-17 14:30（UTC）
const BASE = Date.UTC(2026, 9, 17, 14, 30, 0);
/** `BASE` からの経過（分） */
const at = (minutes: number) => new Date(BASE + minutes * 60_000);

const TOKYO = "Asia/Tokyo";
const UTC = "UTC";

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, "0")}`;

const sessionStartedAt = (minutes: number, operations: Session["events"][number][] = []) => {
  const session: Session = {
    id: v.parse(SessionId.schema, uuid()),
    events: [
      { kind: "Start", id: v.parse(SessionEventId.schema, uuid()), at: at(minutes) },
      ...operations.flatMap((operation) => (operation.kind === "Start" ? [] : [operation])),
    ],
    journalEntryTimes: [],
  };
  return session;
};

const endAt = (minutes: number) =>
  ({
    kind: "End",
    id: v.parse(SessionEventId.schema, uuid()),
    at: at(minutes),
  }) as const satisfies Session["events"][number];

const entryAt = (
  session: Session,
  minutes: number,
  text = `${minutes}分のメモ`,
  writtenDuring: WrittenDuring = { kind: "Focus", round: 1, setNumber: 1 },
): JournalEntry => ({
  id: v.parse(JournalEntryId.schema, uuid()),
  sessionId: session.id,
  body: v.parse(JournalEntryBody.schema, text),
  tags: [],
  writtenAt: at(minutes),
  updatedAt: at(minutes),
  writtenDuring,
});

const build = (
  sessions: ReadonlyArray<TimelineSession>,
  now: Date,
  timeZone = TOKYO,
  next: TimelineCursor = { kind: "End" },
) => Timeline.build({ sessions, next, now, timeZone });

/** 日付の区切りごとの、日付・完了セット数・セッションごとの記入の本文 */
const outline = (days: ReadonlyArray<TimelineDay>) =>
  days.map((day) => ({
    date: day.date.key,
    completedSets: day.completedSets,
    sessions: day.sessions.map((session) => session.entries.map((entry) => entry.body.unwrap())),
  }));

describe("日付の区切り", () => {
  // 23:30 に始めて 0:20 に終えたセッション。日付をまたぐ
  const overMidnight = sessionStartedAt(0, [endAt(50)]);
  const entries = [entryAt(overMidnight, 20, "23:50"), entryAt(overMidnight, 35, "0:05")];

  test("端末のタイムゾーンの 0:00 で区切り、日付をまたいだセッションは両方の日付に出る", () => {
    expect(outline(build([{ session: overMidnight, entries }], at(80), TOKYO))).toMatchObject([
      { date: "2026-10-18", sessions: [["0:05"]] },
      { date: "2026-10-17", sessions: [["23:50"]] },
    ]);
  });

  test("タイムゾーンが違えば区切りも変わる（UTC ではどちらも 10月17日）", () => {
    expect(outline(build([{ session: overMidnight, entries }], at(80), UTC))).toMatchObject([
      { date: "2026-10-17", sessions: [["0:05", "23:50"]] },
    ]);
  });

  test("日付の区切りには、集中を終えた時刻の日付で数えたその日の完了セット数を出す", () => {
    // 23:37・23:45・23:53 に1〜3セット目、休憩のあと 0:06 と 0:14 に次のラウンドの1・2セット目を終える
    expect(outline(build([{ session: overMidnight, entries }], at(80)))).toMatchObject([
      { date: "2026-10-18", completedSets: { kind: "Counted", count: 2 } },
      { date: "2026-10-17", completedSets: { kind: "Counted", count: 3 } },
    ]);
  });

  test("同じ日の完了セット数は、その日のセッションをすべて足したもの", () => {
    const first = sessionStartedAt(-300, [endAt(-290)]);
    const second = sessionStartedAt(-200, [endAt(-180)]);

    expect(
      outline(
        build(
          [
            { session: first, entries: [] },
            { session: second, entries: [] },
          ],
          at(0),
        ),
      ),
    ).toEqual([
      { date: "2026-10-17", completedSets: { kind: "Counted", count: 3 }, sessions: [[], []] },
    ]);
  });

  test("記入のないセッションも、始まった日に区切りが出る", () => {
    const quiet = sessionStartedAt(-60, [endAt(-55)]);

    expect(outline(build([{ session: quiet, entries: [] }], at(0)))).toEqual([
      { date: "2026-10-17", completedSets: { kind: "Counted", count: 0 }, sessions: [[]] },
    ]);
  });

  test("進行中のセッションは、今までに完了したセットだけを数える", () => {
    const running = sessionStartedAt(-20);

    expect(build([{ session: running, entries: [] }], at(-10))[0]?.completedSets).toEqual({
      kind: "Counted",
      count: 1,
    });
  });
});

describe("並び順", () => {
  test("日付・セッション・記入のどれも新しい順に並ぶ", () => {
    const yesterday = sessionStartedAt(-24 * 60, [endAt(-24 * 60 + 9)]);
    const morning = sessionStartedAt(-600, [endAt(-590)]);
    const evening = sessionStartedAt(-60, [endAt(-50)]);
    const sessions = [
      { session: morning, entries: [entryAt(morning, -595, "朝2"), entryAt(morning, -598, "朝1")] },
      { session: evening, entries: [entryAt(evening, -58, "夜1"), entryAt(evening, -52, "夜2")] },
      { session: yesterday, entries: [entryAt(yesterday, -24 * 60 + 1, "昨日")] },
    ];

    expect(
      outline(build(sessions, at(0))).map(({ date, sessions }) => ({ date, sessions })),
    ).toEqual([
      {
        date: "2026-10-17",
        sessions: [
          ["夜2", "夜1"],
          ["朝2", "朝1"],
        ],
      },
      { date: "2026-10-16", sessions: [["昨日"]] },
    ]);
  });
});

describe("古いページが残っているとき", () => {
  test("読み込んだうちでいちばん古いセッションが始まった日は、完了セット数を数えない", () => {
    const older = sessionStartedAt(-24 * 60, [endAt(-24 * 60 + 9)]);
    const newer = sessionStartedAt(-60, [endAt(-50)]);
    const sessions = [
      { session: newer, entries: [] },
      { session: older, entries: [] },
    ];

    const days = build(sessions, at(0), TOKYO, { kind: "More", before: at(-24 * 60) });

    expect(days.map((day) => [day.date.key, day.completedSets])).toEqual([
      ["2026-10-17", { kind: "Counted", count: 1 }],
      ["2026-10-16", { kind: "NotYetCounted" }],
    ]);
  });

  test("数が確定しない日には、スタッツで数えた今日の完了セット数を入れられる", () => {
    const older = sessionStartedAt(-24 * 60, [endAt(-24 * 60 + 9)]);
    const newer = sessionStartedAt(-60, [endAt(-50)]);
    const days = build(
      [
        { session: newer, entries: [] },
        { session: older, entries: [] },
      ],
      at(0),
      TOKYO,
      { kind: "More", before: at(-24 * 60) },
    );

    const counted = Timeline.withDayCounted(days, "2026-10-16", 14);
    // 確定している日はそのまま
    const unchanged = Timeline.withDayCounted(days, "2026-10-17", 14);

    expect(counted.map((day) => day.completedSets)).toEqual([
      { kind: "Counted", count: 1 },
      { kind: "Counted", count: 14 },
    ]);
    expect(unchanged).toEqual(days);
  });
});

describe("読み込んだ記録の更新", () => {
  const a = sessionStartedAt(-120, [endAt(-110)]);
  const b = sessionStartedAt(-60);

  test("重ねると同じセッションは新しいほうで置き換え、開始の新しい順に並ぶ", () => {
    const ended: Session = { ...b, events: [...b.events, endAt(-50)] };

    const merged = Timeline.merge(
      [
        { session: a, entries: [] },
        { session: b, entries: [] },
      ],
      [{ session: ended, entries: [] }],
    );

    expect(merged.map(({ session }) => session)).toEqual([ended, a]);
  });

  test("現在のセッションはタイマーの操作イベントで置き換え、記入は残す", () => {
    const entry = entryAt(b, -55);
    const paused: Session = {
      ...b,
      events: [
        ...b.events,
        { kind: "Pause", id: v.parse(SessionEventId.schema, uuid()), at: at(-50) },
      ],
    };

    const sessions = Timeline.withCurrentSession([{ session: b, entries: [entry] }], paused);

    expect(sessions).toEqual([{ session: paused, entries: [entry] }]);
  });

  test("タイムラインにない現在のセッションは、いちばん上に足す", () => {
    expect(Timeline.withCurrentSession([{ session: a, entries: [] }], b)).toEqual([
      { session: b, entries: [] },
      { session: a, entries: [] },
    ]);
  });

  test("書いた記入はそのセッションに入り、編集した記入は置き換わり、削除した記入は消える", () => {
    const entry = entryAt(b, -55, "書いた");
    const edited = { ...entry, body: v.parse(JournalEntryBody.schema, "直した") };
    const loaded = [
      { session: b, entries: [] },
      { session: a, entries: [] },
    ];

    const written = Timeline.putEntry(loaded, entry);
    expect(written[0]?.entries).toEqual([entry]);
    expect(Timeline.putEntry(written, edited)[0]?.entries).toEqual([edited]);
    expect(Timeline.removeEntry(written, entry.id)[0]?.entries).toEqual([]);
  });
});

describe("ページ", () => {
  const sessions = [-30, -60, -90].map((m) => ({ session: sessionStartedAt(m), entries: [] }));

  test("1件多く読めていれば、次のページはいちばん古いセッションの開始時刻より前から", () => {
    expect(Timeline.page(sessions, 2, at(0))).toEqual({
      serverTime: at(0),
      sessions: sessions.slice(0, 2),
      next: { kind: "More", before: at(-60) },
    });
  });

  test("limit 件以下なら、これより古いページはない", () => {
    expect(Timeline.page(sessions, 3, at(0)).next).toEqual({ kind: "End" });
  });

  test("JSON にしたページはスキーマで検証して戻せ、記入の本文は Sensitive に包み直す", () => {
    const session = sessionStartedAt(-30);
    const page = Timeline.page([{ session, entries: [entryAt(session, -25, "本文")] }], 10, at(0));

    const parsed = schemaResult(TimelinePageJsonSchema)(
      JSON.parse(JSON.stringify(Timeline.toJson(page))),
    );

    expect(Result.isSuccess(parsed) && parsed.value.sessions[0]?.session).toEqual(session);
    expect(Result.isSuccess(parsed) && parsed.value.sessions[0]?.entries[0]?.body.unwrap()).toBe(
      "本文",
    );
  });
});

describe("今日の完了セットと記入の数", () => {
  // 23:30 に始めて 0:20 に終えたセッション。日付をまたぐ
  const overMidnight = sessionStartedAt(0, [endAt(50)]);
  const entries = [entryAt(overMidnight, 20, "23:50"), entryAt(overMidnight, 35, "0:05")];
  const days = build([{ session: overMidnight, entries }], at(80));

  test("今日の完了セット数は、端末のタイムゾーンで今日の日付の区切りの数", () => {
    expect(Timeline.completedSetsOn(days, at(80), TOKYO)).toEqual({ kind: "Counted", count: 2 });
  });

  test("今日の区切りがなければ、今日の完了セットはまだない", () => {
    expect(Timeline.completedSetsOn(days, at(60 * 24 + 80), TOKYO)).toEqual({
      kind: "Counted",
      count: 0,
    });
  });

  test("進行中のセッションでセットが完了すると、その時刻から今日の完了セット数が増える", () => {
    const running = sessionStartedAt(40);
    const before = build([{ session: running, entries: [] }], at(46));
    const after = build([{ session: running, entries: [] }], at(47));

    expect(Timeline.completedSetsOn(before, at(46), TOKYO)).toEqual({ kind: "Counted", count: 0 });
    expect(Timeline.completedSetsOn(after, at(47), TOKYO)).toEqual({ kind: "Counted", count: 1 });
  });

  test("セッションの区切りには、そのセッションがその日に完了したセットの数を持つ", () => {
    expect(days.map((day) => day.sessions.map((daySession) => daySession.completedSets))).toEqual([
      [2],
      [3],
    ]);
  });

  test("日付をまたいだセッションの記入の数は、すべての日付の分を足す", () => {
    expect(Timeline.entryCountOf(days, overMidnight.id)).toBe(2);
  });
});
