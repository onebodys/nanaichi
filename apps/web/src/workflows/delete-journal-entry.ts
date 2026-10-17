import { Result } from "@praha/byethrow";
import {
  JournalEntryId,
  type DeleteJournalEntry,
  type DeletedJournalEntry,
  type FindJournalEntry,
} from "../domain/journal-entry.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import { journalEntryNotFound, type JournalEntryNotFound } from "./journal-entry-not-found.ts";

export type DeleteJournalEntryError = ValidationError | JournalEntryNotFound;

export type DeleteJournalEntryDeps = Readonly<{
  findJournalEntry: FindJournalEntry;
  deleteJournalEntry: DeleteJournalEntry;
}>;

const parseId = schemaResult(JournalEntryId.schema);

/** 削除する。すでに削除してあれば、通信のやり直しとして記録済みの削除を返す */
const remove =
  (deps: DeleteJournalEntryDeps, now: Date) =>
  (id: JournalEntryId): Result.Result<DeletedJournalEntry, JournalEntryNotFound> => {
    const recorded = deps.findJournalEntry(id);
    if (recorded === undefined) {
      return Result.fail(journalEntryNotFound(id));
    }
    if (recorded.kind === "Deleted") {
      return Result.succeed(recorded.deleted);
    }
    const deleted: DeletedJournalEntry = { id, deletedAt: now };
    deps.deleteJournalEntry(deleted);
    return Result.succeed(deleted);
  };

/**
 * ジャーナル記入を削除する（論理削除、ADR 0010）。
 *
 * 入力の検証 → 記入の読み込みと削除。セッションが終わったあとでもできる。
 * 削除した記入はタイムラインに出ないが、自動終了の判断では書いたものとして数える。
 */
export const deleteJournalEntry =
  (deps: DeleteJournalEntryDeps) =>
  (rawId: unknown, now: Date): Result.Result<DeletedJournalEntry, DeleteJournalEntryError> =>
    Result.pipe(parseId(rawId), Result.andThen(remove(deps, now)));
