import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { goldenCases, type Plain } from "../testing/golden.ts";
import {
  journalEntryOf,
  localDate,
  sessionFields,
  sessionOf,
  uuid,
  type JournalEntryFields,
  type SessionSpec,
} from "../testing/golden-values.ts";
import { JournalEntryId, type JournalEntry } from "./journal-entry.ts";
import { schemaResult } from "./schema-result.ts";
import { SessionId } from "./session.ts";
import { TagName, type DeletedTag } from "./tag.ts";
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
const END: TimelineCursor = { kind: "End" };

/** 番号 `n` のセッションが `start` 分に始まり、`end` 分に終わる（終わらなければ進行中） */
const session = (n: number, start: number, end?: number): SessionSpec => ({
  n,
  startedAt: at(start),
  operations: end === undefined ? [] : [{ kind: "End", at: at(end) }],
});

/** 番号 `n` の記入。セッション `owner` の中で `minutes` 分に書いた集中中の記入 */
const entry = (
  n: number,
  owner: SessionSpec,
  minutes: number,
  text: string,
  tags: ReadonlyArray<string> = [],
): JournalEntryFields => ({
  id: uuid(1000 + n),
  sessionId: uuid(owner.n),
  body: text,
  tags,
  writtenAt: at(minutes),
  updatedAt: at(minutes),
  writtenDuring: { kind: "Focus", round: 1, setNumber: 1 },
});

const loaded = (
  spec: SessionSpec,
  entries: ReadonlyArray<JournalEntryFields> = [],
): TimelineSession => ({ session: sessionOf(spec), entries: entries.map(journalEntryOf) });

const loadedFields = (spec: SessionSpec, entries: ReadonlyArray<JournalEntryFields> = []) => ({
  session: sessionFields(spec),
  entries,
});

type DayFields = Plain<TimelineDay>;

/** 画面に出す日付の区切りを、ワークフローに渡す型にする */
const daysOf = (days: ReadonlyArray<DayFields>): ReadonlyArray<TimelineDay> =>
  days.map((day) => ({
    ...day,
    sessions: day.sessions.map((daySession) => ({
      ...daySession,
      sessionId: v.parse(SessionId.schema, daySession.sessionId),
      entries: daySession.entries.map(journalEntryOf),
    })),
  }));

const counted = (count: number) => ({ kind: "Counted", count }) as const;

const buildOf = (
  sessions: ReadonlyArray<TimelineSession>,
  now: Date,
  timeZone = TOKYO,
  next: TimelineCursor = END,
) => ({ sessions, next, now, timeZone });

goldenCases("Timeline.build", Timeline.build, [
  ...(() => {
    // 23:30 に始めて 0:20 に終えたセッション。日付をまたぐ
    const overMidnight = session(1, 0, 50);
    const lateEntry = entry(1, overMidnight, 20, "23:50");
    const earlyEntry = entry(2, overMidnight, 35, "0:05");
    const sessions = [loaded(overMidnight, [lateEntry, earlyEntry])];
    return [
      {
        // 23:37・23:45・23:53 に1〜3セット目、休憩のあと 0:06 と 0:14 に次のラウンドの1・2セット目を終える
        name: "端末のタイムゾーンの 0:00 で区切り、日付をまたいだセッションは両方の日付に出る。完了セット数は集中を終えた時刻の日付で数える",
        input: buildOf(sessions, at(80), TOKYO),
        expected: [
          {
            date: localDate(2026, 10, 18),
            completedSets: counted(2),
            sessions: [
              {
                sessionId: uuid(1),
                startedAt: at(0),
                completedSets: 2,
                entries: [earlyEntry],
              },
            ],
          },
          {
            date: localDate(2026, 10, 17),
            completedSets: counted(3),
            sessions: [
              {
                sessionId: uuid(1),
                startedAt: at(0),
                completedSets: 3,
                entries: [lateEntry],
              },
            ],
          },
        ],
      },
      {
        name: "タイムゾーンが違えば区切りも変わる（UTC ではどちらも 10月17日）",
        input: buildOf(sessions, at(80), UTC),
        expected: [
          {
            date: localDate(2026, 10, 17),
            completedSets: counted(5),
            sessions: [
              {
                sessionId: uuid(1),
                startedAt: at(0),
                completedSets: 5,
                entries: [earlyEntry, lateEntry],
              },
            ],
          },
        ],
      },
    ];
  })(),
  ...(() => {
    const first = session(1, -300, -290);
    const second = session(2, -200, -180);
    return [
      {
        name: "同じ日の完了セット数は、その日のセッションをすべて足したもの",
        input: buildOf([loaded(first), loaded(second)], at(0)),
        expected: [
          {
            date: localDate(2026, 10, 17),
            completedSets: counted(3),
            sessions: [
              { sessionId: uuid(2), startedAt: at(-200), completedSets: 2, entries: [] },
              { sessionId: uuid(1), startedAt: at(-300), completedSets: 1, entries: [] },
            ],
          },
        ],
      },
    ];
  })(),
  {
    name: "記入のないセッションも、始まった日に区切りが出る",
    input: buildOf([loaded(session(1, -60, -55))], at(0)),
    expected: [
      {
        date: localDate(2026, 10, 17),
        completedSets: counted(0),
        sessions: [{ sessionId: uuid(1), startedAt: at(-60), completedSets: 0, entries: [] }],
      },
    ],
  },
  {
    name: "進行中のセッションは、今までに完了したセットだけを数える",
    input: buildOf([loaded(session(1, -20))], at(-10)),
    expected: [
      {
        date: localDate(2026, 10, 17),
        completedSets: counted(1),
        sessions: [{ sessionId: uuid(1), startedAt: at(-20), completedSets: 1, entries: [] }],
      },
    ],
  },
  ...(() => {
    const yesterday = session(1, -24 * 60, -24 * 60 + 9);
    const morning = session(2, -600, -590);
    const evening = session(3, -60, -50);
    const morning2 = entry(1, morning, -595, "朝2");
    const morning1 = entry(2, morning, -598, "朝1");
    const evening1 = entry(3, evening, -58, "夜1");
    const evening2 = entry(4, evening, -52, "夜2");
    const yesterdayEntry = entry(5, yesterday, -24 * 60 + 1, "昨日");
    return [
      {
        name: "日付・セッション・記入のどれも新しい順に並ぶ",
        input: buildOf(
          [
            loaded(morning, [morning2, morning1]),
            loaded(evening, [evening1, evening2]),
            loaded(yesterday, [yesterdayEntry]),
          ],
          at(0),
        ),
        expected: [
          {
            date: localDate(2026, 10, 17),
            completedSets: counted(2),
            sessions: [
              {
                sessionId: uuid(3),
                startedAt: at(-60),
                completedSets: 1,
                entries: [evening2, evening1],
              },
              {
                sessionId: uuid(2),
                startedAt: at(-600),
                completedSets: 1,
                entries: [morning2, morning1],
              },
            ],
          },
          {
            date: localDate(2026, 10, 16),
            completedSets: counted(1),
            sessions: [
              {
                sessionId: uuid(1),
                startedAt: at(-24 * 60),
                completedSets: 1,
                entries: [yesterdayEntry],
              },
            ],
          },
        ],
      },
    ];
  })(),
  {
    name: "読み込んだうちでいちばん古いセッションが始まった日は、完了セット数を数えない",
    input: buildOf(
      [loaded(session(2, -60, -50)), loaded(session(1, -24 * 60, -24 * 60 + 9))],
      at(0),
      TOKYO,
      { kind: "More", before: at(-24 * 60) },
    ),
    expected: [
      {
        date: localDate(2026, 10, 17),
        completedSets: counted(1),
        sessions: [{ sessionId: uuid(2), startedAt: at(-60), completedSets: 1, entries: [] }],
      },
      {
        date: localDate(2026, 10, 16),
        completedSets: { kind: "NotYetCounted" },
        sessions: [{ sessionId: uuid(1), startedAt: at(-24 * 60), completedSets: 1, entries: [] }],
      },
    ],
  },
  {
    name: "進行中のセッションは、集中を終える前の時刻にはまだセットを数えない",
    input: buildOf([loaded(session(1, 40))], at(46)),
    expected: [
      {
        date: localDate(2026, 10, 18),
        completedSets: counted(0),
        sessions: [{ sessionId: uuid(1), startedAt: at(40), completedSets: 0, entries: [] }],
      },
    ],
  },
  {
    name: "進行中のセッションでセットが完了すると、その時刻から完了セット数が増える",
    input: buildOf([loaded(session(1, 40))], at(47)),
    expected: [
      {
        date: localDate(2026, 10, 18),
        completedSets: counted(1),
        sessions: [{ sessionId: uuid(1), startedAt: at(40), completedSets: 1, entries: [] }],
      },
    ],
  },
]);

// 日付をまたいだセッション（`Timeline.build` の最初の場面と同じ区切り）
const overMidnight = session(1, 0, 50);
const OVER_MIDNIGHT_DAYS: ReadonlyArray<DayFields> = [
  {
    date: localDate(2026, 10, 18),
    completedSets: counted(2),
    sessions: [
      {
        sessionId: uuid(1),
        startedAt: at(0),
        completedSets: 2,
        entries: [entry(2, overMidnight, 35, "0:05")],
      },
    ],
  },
  {
    date: localDate(2026, 10, 17),
    completedSets: counted(3),
    sessions: [
      {
        sessionId: uuid(1),
        startedAt: at(0),
        completedSets: 3,
        entries: [entry(1, overMidnight, 20, "23:50")],
      },
    ],
  },
];

/** 古いページが残っているときの日付の区切り。10月16日の完了セット数は確定していない */
const OCT_17: DayFields = {
  date: localDate(2026, 10, 17),
  completedSets: counted(1),
  sessions: [{ sessionId: uuid(2), startedAt: at(-60), completedSets: 1, entries: [] }],
};
const OCT_16_UNCOUNTED: DayFields = {
  date: localDate(2026, 10, 16),
  completedSets: { kind: "NotYetCounted" },
  sessions: [{ sessionId: uuid(1), startedAt: at(-24 * 60), completedSets: 1, entries: [] }],
};
const OLD_PAGE_DAYS = [OCT_17, OCT_16_UNCOUNTED];

goldenCases(
  "Timeline.completedSetsOn",
  (input: { days: ReadonlyArray<TimelineDay>; now: Date; timeZone: string }) =>
    Timeline.completedSetsOn(input.days, input.now, input.timeZone),
  [
    {
      name: "今日の完了セット数は、端末のタイムゾーンで今日の日付の区切りの数",
      input: { days: daysOf(OVER_MIDNIGHT_DAYS), now: at(80), timeZone: TOKYO },
      expected: counted(2),
    },
    {
      name: "今日の区切りがなければ、今日の完了セットはまだない",
      input: { days: daysOf(OVER_MIDNIGHT_DAYS), now: at(60 * 24 + 80), timeZone: TOKYO },
      expected: counted(0),
    },
    {
      name: "今日の区切りの数が確定していなければ、確定していないまま返す",
      input: { days: daysOf(OLD_PAGE_DAYS), now: at(-24 * 60 + 10), timeZone: TOKYO },
      expected: { kind: "NotYetCounted" },
    },
  ],
);

goldenCases(
  "Timeline.withDayCounted",
  (input: { days: ReadonlyArray<TimelineDay>; dateKey: string; count: number }) =>
    Timeline.withDayCounted(input.days, input.dateKey, input.count),
  [
    {
      name: "数が確定しない日には、スタッツで数えた今日の完了セット数を入れられる",
      input: { days: daysOf(OLD_PAGE_DAYS), dateKey: "2026-10-16", count: 14 },
      expected: [OCT_17, { ...OCT_16_UNCOUNTED, completedSets: counted(14) }],
    },
    {
      name: "確定している日はそのまま",
      input: { days: daysOf(OLD_PAGE_DAYS), dateKey: "2026-10-17", count: 14 },
      expected: OLD_PAGE_DAYS,
    },
  ],
);

goldenCases(
  "Timeline.entryCountOf",
  (input: { days: ReadonlyArray<TimelineDay>; sessionId: ReturnType<typeof sessionOf>["id"] }) =>
    Timeline.entryCountOf(input.days, input.sessionId),
  [
    {
      name: "日付をまたいだセッションの記入の数は、すべての日付の分を足す",
      input: { days: daysOf(OVER_MIDNIGHT_DAYS), sessionId: sessionOf(overMidnight).id },
      expected: 2,
    },
  ],
);

const a = session(1, -120, -110);
const b = session(2, -60);
const bEnded: SessionSpec = {
  ...b,
  operations: [{ kind: "End", at: at(-50) }],
};
const bPaused: SessionSpec = {
  ...b,
  operations: [{ kind: "Pause", at: at(-50) }],
};

goldenCases(
  "Timeline.merge",
  (input: { loaded: ReadonlyArray<TimelineSession>; more: ReadonlyArray<TimelineSession> }) =>
    Timeline.merge(input.loaded, input.more),
  [
    {
      name: "重ねると同じセッションは新しいほうで置き換え、開始の新しい順に並ぶ",
      input: { loaded: [loaded(a), loaded(b)], more: [loaded(bEnded)] },
      expected: [loadedFields(bEnded), loadedFields(a)],
    },
  ],
);

const memo = entry(1, b, -55, "メモ");

goldenCases(
  "Timeline.withCurrentSession",
  (input: { sessions: ReadonlyArray<TimelineSession>; current: ReturnType<typeof sessionOf> }) =>
    Timeline.withCurrentSession(input.sessions, input.current),
  [
    {
      name: "現在のセッションはタイマーの操作イベントで置き換え、記入は残す",
      input: { sessions: [loaded(b, [memo])], current: sessionOf(bPaused) },
      expected: [loadedFields(bPaused, [memo])],
    },
    {
      name: "タイムラインにない現在のセッションは、いちばん上に足す",
      input: { sessions: [loaded(a)], current: sessionOf(b) },
      expected: [loadedFields(b), loadedFields(a)],
    },
  ],
);

const written = entry(2, b, -55, "書いた");
const edited = { ...written, body: "直した" };

goldenCases(
  "Timeline.putEntry",
  (input: { sessions: ReadonlyArray<TimelineSession>; entry: JournalEntry }) =>
    Timeline.putEntry(input.sessions, input.entry),
  [
    {
      name: "書いた記入はそのセッションに入る",
      input: { sessions: [loaded(b), loaded(a)], entry: journalEntryOf(written) },
      expected: [loadedFields(b, [written]), loadedFields(a)],
    },
    {
      name: "編集した記入は置き換わる",
      input: { sessions: [loaded(b, [written]), loaded(a)], entry: journalEntryOf(edited) },
      expected: [loadedFields(b, [edited]), loadedFields(a)],
    },
  ],
);

goldenCases(
  "Timeline.removeEntry",
  (input: { sessions: ReadonlyArray<TimelineSession>; id: JournalEntry["id"] }) =>
    Timeline.removeEntry(input.sessions, input.id),
  [
    {
      name: "削除した記入は消える",
      input: {
        sessions: [loaded(b, [written]), loaded(a)],
        id: v.parse(JournalEntryId.schema, written.id),
      },
      expected: [loadedFields(b), loadedFields(a)],
    },
  ],
);

goldenCases(
  "Timeline.deleteTag",
  (input: { sessions: ReadonlyArray<TimelineSession>; deleted: DeletedTag }) =>
    Timeline.deleteTag(input.sessions, input.deleted),
  [
    {
      name: "タグを削除すると、読み込んだどのセッションの記入からも外れ、更新時刻は変わらない",
      input: {
        sessions: [
          loaded(b, [entry(1, b, -55, "メモ", ["読書"])]),
          loaded(a, [entry(2, a, -85, "メモ", ["本", "読書"])]),
        ],
        deleted: {
          name: v.parse(TagName.schema, "読書"),
          deletion: { kind: "Reassign", to: v.parse(TagName.schema, "本") },
        },
      },
      expected: [
        loadedFields(b, [entry(1, b, -55, "メモ", ["本"])]),
        loadedFields(a, [entry(2, a, -85, "メモ", ["本"])]),
      ],
    },
  ],
);

const threeSessions = [session(1, -30), session(2, -60), session(3, -90)];

goldenCases(
  "Timeline.page",
  (input: { found: ReadonlyArray<TimelineSession>; limit: number; serverTime: Date }) =>
    Timeline.page(input.found, input.limit, input.serverTime),
  [
    {
      name: "1件多く読めていれば、次のページはいちばん古いセッションの開始時刻より前から",
      input: { found: threeSessions.map((spec) => loaded(spec)), limit: 2, serverTime: at(0) },
      expected: {
        serverTime: at(0),
        sessions: threeSessions.slice(0, 2).map((spec) => loadedFields(spec)),
        next: { kind: "More", before: at(-60) },
      },
    },
    {
      name: "limit 件以下なら、これより古いページはない",
      input: { found: threeSessions.map((spec) => loaded(spec)), limit: 3, serverTime: at(0) },
      expected: {
        serverTime: at(0),
        sessions: threeSessions.map((spec) => loadedFields(spec)),
        next: { kind: "End" },
      },
    },
  ],
);

describe("タイムラインのページの応答", () => {
  test("JSON にしたページはスキーマで検証して戻せ、記入の本文は Sensitive に包み直す", () => {
    const current = session(1, -30);
    const page = Timeline.page([loaded(current, [entry(1, current, -25, "本文")])], 10, at(0));

    const parsed = schemaResult(TimelinePageJsonSchema)(
      JSON.parse(JSON.stringify(Timeline.toJson(page))),
    );

    expect(Result.isSuccess(parsed) && parsed.value.sessions[0]?.session).toEqual(
      sessionOf(current),
    );
    expect(Result.isSuccess(parsed) && parsed.value.sessions[0]?.entries[0]?.body.unwrap()).toBe(
      "本文",
    );
  });
});
