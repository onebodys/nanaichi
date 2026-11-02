import { AdvanceModeChange } from "../domain/advance-mode.ts";
import type {
  DeletedJournalEntry,
  JournalEntry,
  JournalEntryId,
  StoredJournalEntry,
} from "../domain/journal-entry.ts";
import type { RecordedSessionEvents } from "../domain/session-event.ts";
import type { Session, SessionId } from "../domain/session.ts";
import type { EntryMark } from "../domain/stats.ts";
import type { TagName, TagUsage } from "../domain/tag.ts";
import type { TimelineSession } from "../domain/timeline.ts";
import type { Ended } from "../domain/timer-state.ts";
import type { ChangeAdvanceModeDeps } from "../workflows/change-advance-mode.ts";
import type { DeleteJournalEntryDeps } from "../workflows/delete-journal-entry.ts";
import type { DeleteTagDeps } from "../workflows/delete-tag.ts";
import type { EditJournalEntryDeps } from "../workflows/edit-journal-entry.ts";
import type { GetAdvanceModeDeps } from "../workflows/get-advance-mode.ts";
import type { GetEntriesOnDateDeps } from "../workflows/get-entries-on-date.ts";
import type { GetEntriesWithTagDeps } from "../workflows/get-entries-with-tag.ts";
import type { GetJournalCalendarDeps } from "../workflows/get-journal-calendar.ts";
import type { GetJournalPeriodDeps } from "../workflows/get-journal-period.ts";
import type { GetStatsDeps } from "../workflows/get-stats.ts";
import type { GetTagUsageDeps } from "../workflows/get-tag-usage.ts";
import type { GetTagsDeps } from "../workflows/get-tags.ts";
import type { GetTimelineDeps } from "../workflows/get-timeline.ts";
import type { OperateSessionDeps } from "../workflows/operate-session.ts";
import type { StartSessionDeps } from "../workflows/start-session.ts";
import type { WriteJournalEntryDeps } from "../workflows/write-journal-entry.ts";

/**
 * 記録されている記入。削除した記入は本文とタグを捨て、ID・削除した時刻・セッション・書いた時刻だけを残す。
 * ID は同じ記入の再送を見分けるため、書いた時刻は自動終了の判断で削除した記入も数えるため（ADR 0010）。
 */
export type StoredEntry =
  | Readonly<{ kind: "Written"; entry: JournalEntry }>
  | Readonly<{
      kind: "Deleted";
      deleted: DeletedJournalEntry;
      sessionId: SessionId;
      writtenAt: Date;
    }>;

/** `events` は SQLite の `ORDER BY at, rowid` の順に並べておく。同じミリ秒の操作は記録した順になる */
type StoredSession = Readonly<{
  id: SessionId;
  events: RecordedSessionEvents;
  entries: ReadonlyArray<StoredEntry>;
}>;

/** 閉じたセッション。`sessions.ended_at` / `ended_by` と同じものだけを持ち、終了の状態はドメインで計算し直す */
export type ClosedSession = StoredSession & Readonly<{ endedAt: Date; endedBy: Ended["endedBy"] }>;

type OpenSlot =
  | Readonly<{ kind: "NoOpenSession" }>
  | Readonly<{ kind: "Open"; session: StoredSession }>;

export type DeviceRecords = Readonly<{
  /** 閉じた順（= 開始の順） */
  closed: ReadonlyArray<ClosedSession>;
  open: OpenSlot;
  /** SQLite の `ORDER BY changed_at, rowid` の順 */
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>;
}>;

export const DeviceRecords = {
  empty: { closed: [], open: { kind: "NoOpenSession" }, advanceModeChanges: [] },
} as const satisfies Readonly<{ empty: DeviceRecords }>;

/** 保存するときの1件。IndexedDB にはセッションごとに1件ずつ置く（ADR 0019） */
export type SessionRecord =
  | Readonly<{ kind: "Open"; session: StoredSession }>
  | Readonly<{ kind: "Closed"; session: ClosedSession }>;

export const sessionRecordsOf = (records: DeviceRecords): ReadonlyArray<SessionRecord> => {
  const closed = records.closed.map((session): SessionRecord => ({ kind: "Closed", session }));
  switch (records.open.kind) {
    case "NoOpenSession":
      return closed;
    case "Open":
      return [...closed, { kind: "Open", session: records.open.session }];
  }
};

export const changedSessionRecords = (
  base: DeviceRecords,
  current: DeviceRecords,
): ReadonlyArray<SessionRecord> => {
  const unchanged = new Set<StoredSession>(sessionRecordsOf(base).map(({ session }) => session));
  return sessionRecordsOf(current).filter(({ session }) => !unchanged.has(session));
};

const latestRecordedAt = (records: DeviceRecords): Date | undefined => {
  let latest = Number.NEGATIVE_INFINITY;
  const see = (time: Date) => {
    latest = Math.max(latest, time.getTime());
  };
  for (const record of sessionRecordsOf(records)) {
    record.session.events.forEach(({ at }) => see(at));
    if (record.kind === "Closed") {
      see(record.session.endedAt);
    }
    for (const stored of record.session.entries) {
      switch (stored.kind) {
        case "Written":
          see(stored.entry.writtenAt);
          see(stored.entry.updatedAt);
          break;
        case "Deleted":
          see(stored.writtenAt);
          see(stored.deleted.deletedAt);
          break;
      }
    }
  }
  records.advanceModeChanges.forEach(({ at }) => see(at));
  return Number.isFinite(latest) ? new Date(latest) : undefined;
};

/** この端末の記録先が記録に使う時刻。端末の時計 `clock` が記録済みの時刻より前に戻っていれば、記録済みの時刻を使う */
export const deviceNow = (clock: () => Date, records: DeviceRecords): Date => {
  const now = clock();
  const latest = latestRecordedAt(records);
  return latest !== undefined && latest.getTime() > now.getTime() ? latest : now;
};

export type RecordsDeps = StartSessionDeps &
  OperateSessionDeps &
  WriteJournalEntryDeps &
  EditJournalEntryDeps &
  DeleteJournalEntryDeps &
  DeleteTagDeps &
  GetTimelineDeps &
  GetStatsDeps &
  GetTagsDeps &
  GetTagUsageDeps &
  GetJournalCalendarDeps &
  GetEntriesOnDateDeps &
  GetEntriesWithTagDeps &
  GetJournalPeriodDeps &
  GetAdvanceModeDeps &
  ChangeAdvanceModeDeps;

/**
 * 1回のワークフローの間だけ使う、書き換えられる入れ物。契約は `current` を読み、新しい値に置き換える。
 * `base` は読み込んだときの値で、保存するときに変わったセッションを見分けるのに使う
 */
export type Draft = { current: DeviceRecords; readonly base: DeviceRecords };

const startedAtOf = (session: StoredSession): Date => session.events[0].at;

const entryIdOf = (stored: StoredEntry): JournalEntryId => {
  switch (stored.kind) {
    case "Written":
      return stored.entry.id;
    case "Deleted":
      return stored.deleted.id;
  }
};

const writtenAtOf = (stored: StoredEntry): Date => {
  switch (stored.kind) {
    case "Written":
      return stored.entry.writtenAt;
    case "Deleted":
      return stored.writtenAt;
  }
};

const writtenEntriesIn = (session: StoredSession): ReadonlyArray<JournalEntry> =>
  session.entries.flatMap((stored) => (stored.kind === "Written" ? [stored.entry] : []));

const byWrittenAt = (a: JournalEntry, b: JournalEntry) =>
  a.writtenAt.getTime() - b.writtenAt.getTime();

/**
 * SQLite の文字列の比較（BINARY、UTF-8 のバイト順）と同じ順。UTF-16 のコード単位で比べる `<` とは、
 * サロゲートペアの文字と U+E000 以降の文字で順序が入れ替わる
 */
const compareCodePoints = (a: string, b: string): number => {
  const x = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const y = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return x.length - y.length;
};

/** 時刻の順を保って足す。同じ時刻のものの後ろに置くので、同じミリ秒は記録した順になる（`ORDER BY at, rowid`） */
const insertInTimeOrder = <T>(items: ReadonlyArray<T>, item: T, atOf: (item: T) => Date) => {
  const at = atOf(item).getTime();
  const position = items.findLastIndex((other) => atOf(other).getTime() <= at) + 1;
  return [...items.slice(0, position), item, ...items.slice(position)];
};

const sessionFrom = (
  stored: StoredSession,
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>,
): Session => ({
  id: stored.id,
  events: stored.events,
  journalEntryTimes: stored.entries.map(writtenAtOf).toSorted((a, b) => a.getTime() - b.getTime()),
  advanceModeChanges,
});

const sessionOf = (records: DeviceRecords, record: SessionRecord): Session => {
  const relevant = AdvanceModeChange.relevantSince(
    records.advanceModeChanges,
    startedAtOf(record.session),
  );
  switch (record.kind) {
    case "Open":
      return sessionFrom(record.session, relevant);
    case "Closed": {
      const endedAt = record.session.endedAt.getTime();
      return sessionFrom(
        record.session,
        relevant.filter((change) => change.at.getTime() <= endedAt),
      );
    }
  }
};

const updateSession = (
  records: DeviceRecords,
  id: SessionId,
  update: (session: StoredSession) => StoredSession,
): DeviceRecords => {
  if (records.open.kind === "Open" && records.open.session.id === id) {
    return { ...records, open: { kind: "Open", session: update(records.open.session) } };
  }
  if (!records.closed.some((session) => session.id === id)) {
    throw new Error("記録にないセッションを書き換えようとした");
  }
  return {
    ...records,
    closed: records.closed.map((session) =>
      session.id === id
        ? { ...update(session), endedAt: session.endedAt, endedBy: session.endedBy }
        : session,
    ),
  };
};

/** 削除していない記入 `id` を書き換える。見つからなければ何もしない（`WHERE deleted_at IS NULL`） */
const updateWrittenEntry = (
  records: DeviceRecords,
  id: JournalEntryId,
  update: (entry: JournalEntry) => StoredEntry,
): DeviceRecords => {
  const isTarget = (stored: StoredEntry) => stored.kind === "Written" && stored.entry.id === id;
  const owner = sessionRecordsOf(records).find(({ session }) => session.entries.some(isTarget));
  if (owner === undefined) {
    return records;
  }
  return updateSession(records, owner.session.id, (session) => ({
    ...session,
    entries: session.entries.map((stored) =>
      stored.kind === "Written" && stored.entry.id === id ? update(stored.entry) : stored,
    ),
  }));
};

/** 並びは SQLite の `ORDER BY MAX(written_at) DESC, name` */
const tagUsageOf = (records: DeviceRecords): ReadonlyArray<TagUsage> => {
  const usage = new Map<TagName, { latest: number; entryCount: number }>();
  for (const { session } of sessionRecordsOf(records)) {
    for (const entry of writtenEntriesIn(session)) {
      for (const name of entry.tags) {
        const seen = usage.get(name) ?? { latest: Number.NEGATIVE_INFINITY, entryCount: 0 };
        usage.set(name, {
          latest: Math.max(seen.latest, entry.writtenAt.getTime()),
          entryCount: seen.entryCount + 1,
        });
      }
    }
  }
  return [...usage]
    .toSorted(([a, x], [b, y]) => y.latest - x.latest || compareCodePoints(a, b))
    .map(([name, { entryCount }]) => ({ name, entryCount }));
};

export const recordsDeps = (draft: Draft): RecordsDeps => {
  const records = () => draft.current;
  const write = (next: DeviceRecords) => {
    draft.current = next;
  };
  const allWrittenEntries = () =>
    sessionRecordsOf(records()).flatMap(({ session }) => writtenEntriesIn(session));

  return {
    findOpenSession: () => {
      const { open } = records();
      return open.kind === "Open" ? sessionOf(records(), open) : undefined;
    },

    findSessionByEventId: (eventId) => {
      const found = sessionRecordsOf(records()).findLast(({ session }) =>
        session.events.some(({ id }) => id === eventId),
      );
      return found === undefined ? undefined : sessionOf(records(), found);
    },

    saveStartedSession: (session) => {
      const current = records();
      if (current.open.kind === "Open") {
        throw new Error("開いているセッションがあるのに、もう1つ開こうとした");
      }
      write({
        ...current,
        open: {
          kind: "Open",
          session: { id: session.id, events: [session.events[0]], entries: [] },
        },
      });
    },

    appendSessionOperation: (sessionId, operation) =>
      write(
        updateSession(records(), sessionId, (session) => {
          const [start, ...operations] = session.events;
          return {
            ...session,
            events: [start, ...insertInTimeOrder(operations, operation, ({ at }) => at)],
          };
        }),
      ),

    closeSession: (sessionId, ended) => {
      const current = records();
      // 開いていないセッションは閉じ直さない（`WHERE ended_at IS NULL`）
      if (current.open.kind !== "Open" || current.open.session.id !== sessionId) {
        return;
      }
      write({
        ...current,
        closed: [
          ...current.closed,
          { ...current.open.session, endedAt: ended.endedAt, endedBy: ended.endedBy },
        ],
        open: { kind: "NoOpenSession" },
      });
    },

    loadAdvanceModeChanges: () => records().advanceModeChanges,

    saveAdvanceModeChange: (change) =>
      write({
        ...records(),
        advanceModeChanges: insertInTimeOrder(records().advanceModeChanges, change, ({ at }) => at),
      }),

    findJournalEntry: (id) => {
      for (const { session } of sessionRecordsOf(records())) {
        const stored = session.entries.find((entry) => entryIdOf(entry) === id);
        if (stored !== undefined) {
          return stored.kind === "Written"
            ? stored
            : ({ kind: "Deleted", deleted: stored.deleted } satisfies StoredJournalEntry);
        }
      }
      return undefined;
    },

    saveJournalEntry: (entry) => {
      const current = records();
      const exists = sessionRecordsOf(current).some(({ session }) =>
        session.entries.some((stored) => entryIdOf(stored) === entry.id),
      );
      if (exists) {
        throw new Error("記録済みの記入と同じ ID で記録しようとした");
      }
      write(
        updateSession(current, entry.sessionId, (session) => ({
          ...session,
          entries: [...session.entries, { kind: "Written", entry }],
        })),
      );
    },

    saveEditedJournalEntry: (edited) =>
      write(
        updateWrittenEntry(records(), edited.id, (entry) => ({
          kind: "Written",
          entry: { ...entry, body: edited.body, tags: edited.tags, updatedAt: edited.updatedAt },
        })),
      ),

    saveJournalEntryTags: (tagged) =>
      write(
        updateWrittenEntry(records(), tagged.id, (entry) => ({
          kind: "Written",
          entry: { ...entry, tags: tagged.tags },
        })),
      ),

    deleteJournalEntry: (deleted) =>
      write(
        updateWrittenEntry(records(), deleted.id, (entry) => ({
          kind: "Deleted",
          deleted,
          sessionId: entry.sessionId,
          writtenAt: entry.writtenAt,
        })),
      ),

    listTagsOfOtherEntries: (id) => [
      ...new Set(
        allWrittenEntries()
          .filter((entry) => entry.id !== id)
          .flatMap((entry) => entry.tags),
      ),
    ],

    listTagsInUse: () => tagUsageOf(records()).map(({ name }) => name),

    listTagUsage: () => tagUsageOf(records()),

    listJournalEntriesTaggedWith: (name) =>
      allWrittenEntries().filter((entry) => entry.tags.includes(name)),

    findTimelineSessions: (range) =>
      sessionRecordsOf(records())
        .filter(
          (record) =>
            range.kind === "Latest" ||
            startedAtOf(record.session).getTime() < range.before.getTime(),
        )
        .toSorted((a, b) => startedAtOf(b.session).getTime() - startedAtOf(a.session).getTime())
        .slice(0, range.limit)
        .map((record): TimelineSession => ({
          session: sessionOf(records(), record),
          entries: writtenEntriesIn(record.session).toSorted(byWrittenAt),
        })),

    findEntryTimesWrittenIn: (window) =>
      allWrittenEntries()
        .map(({ writtenAt }) => writtenAt)
        .filter(
          (at) => at.getTime() >= window.from.getTime() && at.getTime() < window.until.getTime(),
        )
        .toSorted((a, b) => a.getTime() - b.getTime()),

    findJournalEntriesWrittenIn: (window) =>
      allWrittenEntries()
        .filter(
          ({ writtenAt }) =>
            writtenAt.getTime() >= window.from.getTime() &&
            writtenAt.getTime() < window.until.getTime(),
        )
        .toSorted(byWrittenAt),

    findJournalEntriesWithTag: (range) =>
      allWrittenEntries()
        .filter(
          (entry) =>
            entry.tags.includes(range.tag) &&
            (range.kind === "Latest" || entry.writtenAt.getTime() < range.before.getTime()),
        )
        .toSorted((a, b) => byWrittenAt(b, a))
        .slice(0, range.limit),

    findStatsRecords: () => {
      const current = records();
      const sessionRecords = sessionRecordsOf(current);
      return {
        // 閉じたあとの変更は計算に影響しないので、閉じた時刻で絞らない（stats-sqlite.ts と同じ）
        sessions: sessionRecords.map(({ session }) =>
          sessionFrom(
            session,
            AdvanceModeChange.relevantSince(current.advanceModeChanges, startedAtOf(session)),
          ),
        ),
        entries: sessionRecords
          .flatMap(({ session }) => writtenEntriesIn(session))
          .toSorted(byWrittenAt)
          .map(({ sessionId, writtenAt, writtenDuring, tags }): EntryMark => ({
            sessionId,
            writtenAt,
            writtenDuring,
            tags,
          })),
      };
    },
  };
};
