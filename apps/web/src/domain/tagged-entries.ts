import * as v from "valibot";
import { JournalEntry, JournalEntryJsonSchema, type JournalEntryJson } from "./journal-entry.ts";
import { JsonDateSchema } from "./json-date.ts";
import { localDateIn, type LocalDate } from "./local-date.ts";
import { TagName } from "./tag.ts";

/** 1ページに含める記入の数 */
export const TAGGED_ENTRIES_PAGE_SIZE = 20;

/** 次のページ。`before` はこのページでいちばん古い記入を書いた時刻 */
export type TaggedEntriesCursor =
  | Readonly<{ kind: "More"; before: Date }>
  /** これより古い記入はない */
  | Readonly<{ kind: "End" }>;

/**
 * タグ `tag` のついた記入の1ページ（`GET /api/journal-entries/by-tag` の応答）。
 * 削除していない記入を、書いた時刻の新しい順に並べる
 */
export type TaggedEntriesPage = Readonly<{
  tag: TagName;
  entries: ReadonlyArray<JournalEntry>;
  next: TaggedEntriesCursor;
}>;

/** 記録から、タグ `tag` のついた記入を、書いた時刻が `before` より前のものから新しい順に `limit` 件まで読む */
export type TaggedEntriesRange =
  | Readonly<{ kind: "Latest"; tag: TagName; limit: number }>
  | Readonly<{ kind: "Before"; tag: TagName; before: Date; limit: number }>;

/** 画面に出す、書いた日付ごとのまとまり。新しい日付が先 */
export type TaggedEntriesDay = Readonly<{ date: LocalDate; entries: ReadonlyArray<JournalEntry> }>;

const newestFirst = (a: JournalEntry, b: JournalEntry) =>
  b.writtenAt.getTime() - a.writtenAt.getTime();

export const TaggedEntries = {
  /**
   * 記録から読んだ記入を1ページにする。`found` は `limit + 1` 件まで読んだもので、
   * `limit` を超えていれば次のページがある（`Timeline.page` と同じ）。
   */
  page: (tag: TagName, found: ReadonlyArray<JournalEntry>, limit: number): TaggedEntriesPage => {
    const entries = found.slice(0, limit);
    const oldest = entries.at(-1);
    return {
      tag,
      entries,
      next:
        found.length > limit && oldest !== undefined
          ? { kind: "More", before: oldest.writtenAt }
          : { kind: "End" },
    };
  },

  /** 読み込んだ記入 `b` を `a` に足す。同じ ID は `b` で置き換え、書いた時刻の新しい順に並べる */
  merge: (
    a: ReadonlyArray<JournalEntry>,
    b: ReadonlyArray<JournalEntry>,
  ): ReadonlyArray<JournalEntry> => {
    const ids = new Set(b.map(({ id }) => id));
    return [...a.filter(({ id }) => !ids.has(id)), ...b].toSorted(newestFirst);
  },

  /** 新しい順の記入を、タイムゾーン `timeZone`（端末のタイムゾーン）で書いた日付ごとにまとめる */
  byDate: (
    entries: ReadonlyArray<JournalEntry>,
    timeZone: string,
  ): ReadonlyArray<TaggedEntriesDay> => {
    const dateOf = localDateIn(timeZone);
    const days: Array<{ date: LocalDate; entries: Array<JournalEntry> }> = [];
    for (const entry of entries.toSorted(newestFirst)) {
      const date = dateOf(entry.writtenAt);
      const last = days.at(-1);
      if (last !== undefined && last.date.key === date.key) {
        last.entries.push(entry);
      } else {
        days.push({ date, entries: [entry] });
      }
    }
    return days;
  },

  /** 応答に使う JSON にできる形。記入の本文は応答の中でだけ取り出す（ADR 0010） */
  toJson: (page: TaggedEntriesPage): TaggedEntriesPageJson => ({
    ...page,
    entries: page.entries.map(JournalEntry.toJson),
  }),
} as const;

// ---------------------------------------------------------------------------
// API の入力と応答（ADR 0009）
// ---------------------------------------------------------------------------

/**
 * `GET /api/journal-entries/by-tag?tag=&before=` のクエリ。`before` は前のページの `next.before`
 * （ISO 8601）。省けば最新のページになる
 */
export const TaggedEntriesQuerySchema = v.pipe(
  v.object({ tag: TagName.schema, before: v.optional(JsonDateSchema) }),
  v.transform(({ tag, before }): TaggedEntriesRange =>
    // 次のページがあるかを見分けるため、1件多く読む（`TaggedEntries.page`）
    before === undefined
      ? { kind: "Latest", tag, limit: TAGGED_ENTRIES_PAGE_SIZE + 1 }
      : { kind: "Before", tag, before, limit: TAGGED_ENTRIES_PAGE_SIZE + 1 },
  ),
);

/** JSON にした1ページ。記入の本文を取り出してある（ADR 0010） */
export type TaggedEntriesPageJson = Omit<TaggedEntriesPage, "entries"> &
  Readonly<{ entries: ReadonlyArray<JournalEntryJson> }>;

export const TaggedEntriesPageJsonSchema: v.GenericSchema<unknown, TaggedEntriesPage> = v.object({
  tag: TagName.schema,
  entries: v.array(JournalEntryJsonSchema),
  next: v.variant("kind", [
    v.object({ kind: v.literal("More"), before: JsonDateSchema }),
    v.object({ kind: v.literal("End") }),
  ]),
});

// ---------------------------------------------------------------------------
// ワークフローが使う読み書きの契約
// ---------------------------------------------------------------------------

/** タグのついた、削除していない記入を、書いた時刻の新しい順に読む */
export type FindJournalEntriesWithTag = (range: TaggedEntriesRange) => ReadonlyArray<JournalEntry>;
