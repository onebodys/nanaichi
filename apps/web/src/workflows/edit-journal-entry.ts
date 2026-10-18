import { Result } from "@praha/byethrow";
import * as v from "valibot";
import {
  JournalEntry,
  JournalEntryBody,
  JournalEntryId,
  type FindJournalEntry,
  type ListTagsOfOtherEntries,
  type SaveEditedJournalEntry,
} from "../domain/journal-entry.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import { Tag, Tags, type TagLimitExceeded } from "../domain/tag.ts";
import { journalEntryNotFound, type JournalEntryNotFound } from "./journal-entry-not-found.ts";

/**
 * `PATCH /api/journal-entries/:id` の本文。書き直した本文とタグ。
 *
 * タグは省けない。省いたときにタグを外すのか残すのかが決まらず、タグに対応する前の画面から
 * 編集してタグが消えるのを防ぐため（その画面は 400 になり、読み込み直せば直る）。
 */
const EditJournalEntryInputSchema = v.object({
  body: JournalEntryBody.schema,
  tags: Tags.schema,
});

export type EditJournalEntryError = ValidationError | TagLimitExceeded | JournalEntryNotFound;

export type EditJournalEntryDeps = Readonly<{
  findJournalEntry: FindJournalEntry;
  listTagsOfOtherEntries: ListTagsOfOtherEntries;
  saveEditedJournalEntry: SaveEditedJournalEntry;
}>;

const parseId = schemaResult(JournalEntryId.schema);
const parseInput = schemaResult(EditJournalEntryInputSchema);

/** 削除していない記入を探す */
const findWritten =
  (deps: EditJournalEntryDeps) =>
  (id: JournalEntryId): Result.Result<JournalEntry, JournalEntryNotFound> => {
    const recorded = deps.findJournalEntry(id);
    return recorded?.kind === "Written"
      ? Result.succeed(recorded.entry)
      : Result.fail(journalEntryNotFound(id));
  };

/**
 * ジャーナル記入の本文とタグを書き直す。
 *
 * 入力の検証 → 削除していない記入の読み込み → 使っているタグの種類が上限を超えないかの確認
 * → 書き直す → 記録。新しく書くのではないので、
 * セッションが終わったあとでもできる（ADR 0010）。書いた時刻と紐付きは変えない。
 */
export const editJournalEntry =
  (deps: EditJournalEntryDeps) =>
  (rawId: unknown, raw: unknown, now: Date): Result.Result<JournalEntry, EditJournalEntryError> =>
    Result.pipe(
      Result.do(),
      Result.bind("id", () => parseId(rawId)),
      Result.bind("input", () => parseInput(raw)),
      Result.bind("entry", ({ id }) => findWritten(deps)(id)),
      Result.bind("tags", ({ id, input }) =>
        Tag.ensureWithinLimit(deps.listTagsOfOtherEntries(id), input.tags),
      ),
      Result.map(({ entry, input, tags }) =>
        JournalEntry.edit(entry, { body: input.body, tags }, now),
      ),
      Result.andThrough((edited) => Result.succeed(deps.saveEditedJournalEntry(edited))),
    );
