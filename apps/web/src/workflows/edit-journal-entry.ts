import { Result } from "@praha/byethrow";
import * as v from "valibot";
import {
  JournalEntry,
  JournalEntryBody,
  JournalEntryId,
  type FindJournalEntry,
  type SaveEditedJournalEntry,
} from "../domain/journal-entry.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import { journalEntryNotFound, type JournalEntryNotFound } from "./journal-entry-not-found.ts";

/** `PATCH /api/journal-entries/:id` の本文。書き直した本文 */
const EditJournalEntryInputSchema = v.object({ body: JournalEntryBody.schema });

export type EditJournalEntryError = ValidationError | JournalEntryNotFound;

export type EditJournalEntryDeps = Readonly<{
  findJournalEntry: FindJournalEntry;
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
 * ジャーナル記入の本文を書き直す。
 *
 * 入力の検証 → 削除していない記入の読み込み → 書き直す → 記録。新しく書くのではないので、
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
      Result.map(({ entry, input }) => JournalEntry.edit(entry, input.body, now)),
      Result.andThrough((edited) => Result.succeed(deps.saveEditedJournalEntry(edited))),
    );
