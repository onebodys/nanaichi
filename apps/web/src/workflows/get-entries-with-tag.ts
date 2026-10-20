import { Result } from "@praha/byethrow";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import {
  TaggedEntries,
  TaggedEntriesQuerySchema,
  TAGGED_ENTRIES_PAGE_SIZE,
  type FindJournalEntriesWithTag,
  type TaggedEntriesPage,
} from "../domain/tagged-entries.ts";

export type GetEntriesWithTagError = ValidationError;

export type GetEntriesWithTagDeps = Readonly<{
  findJournalEntriesWithTag: FindJournalEntriesWithTag;
}>;

const parseQuery = schemaResult(TaggedEntriesQuerySchema);

/**
 * タグ（GLOSSARY）のついた記入の1ページを返す。
 *
 * クエリ（タグと前のページの続き）の検証 → そのタグのついた記入を新しい順に読む → ページにする。
 */
export const getEntriesWithTag =
  (deps: GetEntriesWithTagDeps) =>
  (rawQuery: unknown): Result.Result<TaggedEntriesPage, GetEntriesWithTagError> =>
    Result.pipe(
      parseQuery(rawQuery),
      Result.map((range) =>
        TaggedEntries.page(
          range.tag,
          deps.findJournalEntriesWithTag(range),
          TAGGED_ENTRIES_PAGE_SIZE,
        ),
      ),
    );
