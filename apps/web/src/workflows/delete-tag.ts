import { Result } from "@praha/byethrow";
import {
  JournalEntry,
  type ListJournalEntriesTaggedWith,
  type SaveJournalEntryTags,
} from "../domain/journal-entry.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import {
  DeletedTag,
  TagDeletion,
  TagName,
  type ListTagsInUse,
  type ReassignToSameTag,
  type TagNotFound,
} from "../domain/tag.ts";

export type DeleteTagError = ValidationError | TagNotFound | ReassignToSameTag;

export type DeleteTagDeps = Readonly<{
  listTagsInUse: ListTagsInUse;
  listJournalEntriesTaggedWith: ListJournalEntriesTaggedWith;
  saveJournalEntryTags: SaveJournalEntryTags;
}>;

const parseName = schemaResult(TagName.schema);
const parseDeletion = schemaResult(TagDeletion.schema);

/** タグがついている記入すべてから、タグを外す（付け替える） */
const applyToEntries =
  (deps: DeleteTagDeps) =>
  (deleted: DeletedTag): void => {
    for (const entry of deps.listJournalEntriesTaggedWith(deleted.name)) {
      deps.saveJournalEntryTags(JournalEntry.deleteTag(entry, deleted));
    }
  };

/**
 * タグを削除する（GLOSSARY の「タグの削除」、ADR 0017）。
 *
 * 入力の検証 → 使っているタグの読み込み → 削除するタグと付け替え先が使われているかの確認
 * → ついている記入すべてからタグを外す（付け替える）。記入は消さず、更新時刻も変えない。
 * 付け替え先は使っているタグなので、タグの種類は増えず、上限を確かめる必要はない。
 */
export const deleteTag =
  (deps: DeleteTagDeps) =>
  (rawName: unknown, raw: unknown): Result.Result<DeletedTag, DeleteTagError> =>
    Result.pipe(
      Result.do(),
      Result.bind("name", () => parseName(rawName)),
      Result.bind("deletion", () => parseDeletion(raw)),
      Result.andThen(({ name, deletion }) =>
        DeletedTag.ensureDeletable(deps.listTagsInUse(), { name, deletion }),
      ),
      Result.andThrough((deleted) => Result.succeed(applyToEntries(deps)(deleted))),
    );
