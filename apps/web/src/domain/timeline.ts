import * as v from "valibot";
import {
  JournalEntry,
  JournalEntryJsonSchema,
  type JournalEntryId,
  type JournalEntryJson,
} from "./journal-entry.ts";
import { JsonDateSchema } from "./json-date.ts";
import { localDateIn, type LocalDate } from "./local-date.ts";
import { Session, SessionJsonSchema, type SessionId } from "./session.ts";

/** 1ページに含めるセッションの数（ADR 0011） */
export const TIMELINE_PAGE_SIZE = 10;

/** タイムラインに並べる1つのセッション。`entries` は削除していない記入（順は問わない） */
export type TimelineSession = Readonly<{
  session: Session;
  entries: ReadonlyArray<JournalEntry>;
}>;

/** 次のページ。`before` はこのページでいちばん古いセッションの開始時刻 */
export type TimelineCursor =
  | Readonly<{ kind: "More"; before: Date }>
  /** これより古いセッションはない */
  | Readonly<{ kind: "End" }>;

/**
 * タイムラインの1ページ（`GET /api/timeline` の応答、ADR 0011）。
 *
 * 開始時刻が新しい順のセッションと、そのセッションの記入。日付の区切りと完了セット数は
 * 端末のタイムゾーンで決まるので、ここでは決めず、画面が `Timeline.build` で組み立てる。
 * 進行中のセッションの完了セット数を計算できるよう、サーバーの時刻を持つ。
 */
export type TimelinePage = Readonly<{
  serverTime: Date;
  sessions: ReadonlyArray<TimelineSession>;
  next: TimelineCursor;
}>;

/** 記録から、開始時刻が `before` より前のセッションを新しい順に `limit` 件まで読む（`Latest` なら最新から） */
export type TimelineRange =
  | Readonly<{ kind: "Latest"; limit: number }>
  | Readonly<{ kind: "Before"; before: Date; limit: number }>;

export type FindTimelineSessions = (range: TimelineRange) => ReadonlyArray<TimelineSession>;

/** JSON にした1ページ。記入の本文を取り出してある（ADR 0010） */
export type TimelinePageJson = Omit<TimelinePage, "sessions"> &
  Readonly<{
    sessions: ReadonlyArray<
      Readonly<{ session: Session; entries: ReadonlyArray<JournalEntryJson> }>
    >;
  }>;

export const TimelinePageJsonSchema: v.GenericSchema<unknown, TimelinePage> = v.object({
  serverTime: JsonDateSchema,
  sessions: v.array(
    v.object({ session: SessionJsonSchema, entries: v.array(JournalEntryJsonSchema) }),
  ),
  next: v.variant("kind", [
    v.object({ kind: v.literal("More"), before: JsonDateSchema }),
    v.object({ kind: v.literal("End") }),
  ]),
});

// ---------------------------------------------------------------------------
// 画面に出すタイムライン（日付とセッションの区切り）
// ---------------------------------------------------------------------------

/**
 * 日付の区切りに出す、その日の完了セット数。
 *
 * まだ読み込んでいない古いセッションがあると、読み込んだうちでいちばん古いセッションが始まった日は
 * 数が確定しない（ADR 0011）。その日は `NotYetCounted` にし、続きを読み込んでから数える。
 */
export type DayCompletedSets =
  | Readonly<{ kind: "Counted"; count: number }>
  | Readonly<{ kind: "NotYetCounted" }>;

/**
 * ある日付の中の、1つのセッションの区切りとその日に書いた記入（新しい順）。
 * `completedSets` はそのセッションがその日に完了したセットの数（集中を終えた時刻の日付で数える）
 */
export type TimelineDaySession = Readonly<{
  sessionId: SessionId;
  startedAt: Date;
  completedSets: number;
  entries: ReadonlyArray<JournalEntry>;
}>;

export type TimelineDay = Readonly<{
  date: LocalDate;
  completedSets: DayCompletedSets;
  /** 開始時刻が新しい順 */
  sessions: ReadonlyArray<TimelineDaySession>;
}>;

const startedAtOf = (session: Session): Date => session.events[0].at;

const newestFirst =
  <T>(atOf: (item: T) => Date) =>
  (a: T, b: T) =>
    atOf(b).getTime() - atOf(a).getTime();

/** 1つのセッションが、ある日付に持つもの */
type SessionOnDay = Readonly<{
  date: LocalDate;
  daySession: TimelineDaySession;
  completedSets: number;
}>;

/**
 * 1つのセッションを日付ごとに分ける。セッションが 0:00 をまたげば、両方の日付に区切りが出る。
 *
 * セッションが現れる日付は、始まった日・記入を書いた日・完了セットになった日のどれか。
 * 記入のないセッションも、始まった日には区切りが出る。
 */
const splitByDay = (
  { session, entries }: TimelineSession,
  now: Date,
  dateOf: (at: Date) => LocalDate,
): ReadonlyArray<SessionOnDay> => {
  const startedAt = startedAtOf(session);
  const completedSetDates = Session.completedSetTimesAt(session, now).map(dateOf);
  const entriesWithDate = entries.map((entry) => ({ entry, date: dateOf(entry.writtenAt) }));
  const dates = new Map(
    [dateOf(startedAt), ...entriesWithDate.map(({ date }) => date), ...completedSetDates].map(
      (date) => [date.key, date],
    ),
  );

  return [...dates.values()].map((date) => {
    const completedSets = completedSetDates.filter(
      (completed) => completed.key === date.key,
    ).length;
    return {
      date,
      daySession: {
        sessionId: session.id,
        startedAt,
        completedSets,
        entries: entriesWithDate
          .filter((item) => item.date.key === date.key)
          .map((item) => item.entry)
          .toSorted(newestFirst((entry) => entry.writtenAt)),
      },
      completedSets,
    };
  });
};

/** 古いセッションが残っていれば、読み込んだうちでいちばん古いセッションが始まった日 */
const uncountedDateKey = (
  sessions: ReadonlyArray<TimelineSession>,
  next: TimelineCursor,
  dateOf: (at: Date) => LocalDate,
): string | undefined => {
  if (next.kind === "End") {
    return undefined;
  }
  const oldest = sessions
    .map(({ session }) => startedAtOf(session))
    .toSorted((a, b) => a.getTime() - b.getTime())[0];
  return oldest === undefined ? undefined : dateOf(oldest).key;
};

export const Timeline = {
  /**
   * 読み込んだセッションから、ある時刻のタイムライン（GLOSSARY の「タイムライン」）を組み立てる。
   *
   * - 日付はタイムゾーン `timeZone`（端末のタイムゾーン）の 0:00 で区切る
   * - 日付・セッション・記入のどれも新しい順
   * - 日付の完了セット数は、集中を終えた時刻がその日付の完了セットを数える。進行中のセッションは
   *   `now` までに完了したものを数える
   * - `next` が `More` なら、いちばん古いセッションが始まった日は数が確定しない
   */
  build: (
    input: Readonly<{
      sessions: ReadonlyArray<TimelineSession>;
      next: TimelineCursor;
      now: Date;
      timeZone: string;
    }>,
  ): ReadonlyArray<TimelineDay> => {
    const dateOf = localDateIn(input.timeZone);
    const uncounted = uncountedDateKey(input.sessions, input.next, dateOf);
    const onDays = input.sessions.flatMap((session) => splitByDay(session, input.now, dateOf));
    const dates = new Map(onDays.map((onDay) => [onDay.date.key, onDay.date]));

    return [...dates.values()]
      .map((date): TimelineDay => {
        const onDate = onDays.filter((onDay) => onDay.date.key === date.key);
        const count = onDate.reduce((sum, onDay) => sum + onDay.completedSets, 0);
        return {
          date,
          completedSets:
            date.key === uncounted ? { kind: "NotYetCounted" } : { kind: "Counted", count },
          sessions: onDate
            .map((onDay) => onDay.daySession)
            .toSorted(newestFirst((daySession) => daySession.startedAt)),
        };
      })
      .toSorted((a, b) => b.date.key.localeCompare(a.date.key));
  },

  /**
   * 時刻 `now` の日付（タイムゾーン `timeZone`）の完了セット数。ヘッダーに出す今日の集中時間のもと。
   *
   * 組み立てたタイムラインにその日付がなければ、その日にはまだ完了セットがない。セッションは
   * 開始の新しい順に読み込むので、今日の完了セットを持つセッションは必ず最新のページに入っている。
   */
  completedSetsOn: (
    days: ReadonlyArray<TimelineDay>,
    now: Date,
    timeZone: string,
  ): DayCompletedSets => {
    const key = localDateIn(timeZone)(now).key;
    return days.find((day) => day.date.key === key)?.completedSets ?? { kind: "Counted", count: 0 };
  },

  /**
   * 数が確定しない日付の区切りに、ほかで数えた完了セット数を入れる。
   *
   * 1日に1ページより多くセッションがあると、今日の区切りの数が確定しない（ADR 0011）。
   * 今日の数はスタッツ（ADR 0014）で数えられるので、それを入れる。確定している日はそのまま
   */
  withDayCounted: (
    days: ReadonlyArray<TimelineDay>,
    dateKey: string,
    count: number,
  ): ReadonlyArray<TimelineDay> =>
    days.map((day) =>
      day.date.key === dateKey && day.completedSets.kind === "NotYetCounted"
        ? { ...day, completedSets: { kind: "Counted", count } }
        : day,
    ),

  /** セッションに書いた記入の数（削除したものを除く）。日付をまたいだセッションは、すべての日付の分を足す */
  entryCountOf: (days: ReadonlyArray<TimelineDay>, sessionId: SessionId): number =>
    days
      .flatMap((day) => day.sessions)
      .filter((daySession) => daySession.sessionId === sessionId)
      .reduce((sum, daySession) => sum + daySession.entries.length, 0),

  /** 読み込んだ記録 `b` を `a` に重ねる。同じセッションは `b` で置き換え、開始時刻が新しい順に並べる */
  merge: (
    a: ReadonlyArray<TimelineSession>,
    b: ReadonlyArray<TimelineSession>,
  ): ReadonlyArray<TimelineSession> => {
    const ids = new Set(b.map(({ session }) => session.id));
    return [...a.filter(({ session }) => !ids.has(session.id)), ...b].toSorted(
      newestFirst(({ session }) => startedAtOf(session)),
    );
  },

  /**
   * 現在のセッション（タイマーのスナップショット）をタイムラインに重ねる。
   *
   * 操作イベントはタイマーのほうが新しいので、それで置き換える。記入はタイムラインのものを残す。
   */
  withCurrentSession: (
    sessions: ReadonlyArray<TimelineSession>,
    current: Session,
  ): ReadonlyArray<TimelineSession> => {
    const entries = sessions.find(({ session }) => session.id === current.id)?.entries ?? [];
    return Timeline.merge(sessions, [{ session: current, entries }]);
  },

  /** 書いた・編集した記入を、そのセッションに入れる（同じ ID なら置き換える） */
  putEntry: (
    sessions: ReadonlyArray<TimelineSession>,
    entry: JournalEntry,
  ): ReadonlyArray<TimelineSession> =>
    sessions.map((item) =>
      item.session.id === entry.sessionId
        ? { ...item, entries: [...item.entries.filter(({ id }) => id !== entry.id), entry] }
        : item,
    ),

  /** 削除した記入を取り除く */
  removeEntry: (
    sessions: ReadonlyArray<TimelineSession>,
    id: JournalEntryId,
  ): ReadonlyArray<TimelineSession> =>
    sessions.map((item) => ({ ...item, entries: item.entries.filter((entry) => entry.id !== id) })),

  /**
   * 記録から読んだセッションを1ページにする。`found` は `limit + 1` 件まで読んだもので、
   * `limit` を超えていれば次のページがある。
   */
  page: (found: ReadonlyArray<TimelineSession>, limit: number, serverTime: Date): TimelinePage => {
    const sessions = found.slice(0, limit);
    const oldest = sessions.at(-1);
    return {
      serverTime,
      sessions,
      next:
        found.length > limit && oldest !== undefined
          ? { kind: "More", before: startedAtOf(oldest.session) }
          : { kind: "End" },
    };
  },

  /** 応答に使う JSON にできる形。記入の本文は応答の中でだけ取り出す（ADR 0010） */
  toJson: (page: TimelinePage): TimelinePageJson => ({
    ...page,
    sessions: page.sessions.map(({ session, entries }) => ({
      session,
      entries: entries.map(JournalEntry.toJson),
    })),
  }),
} as const;
