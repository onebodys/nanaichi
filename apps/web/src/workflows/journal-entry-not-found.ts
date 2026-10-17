import type { JournalEntryId } from "../domain/journal-entry.ts";

/** 記入が記録されていないか、削除されている（ADR 0010） */
export type JournalEntryNotFound = Readonly<{ kind: "JournalEntryNotFound"; id: JournalEntryId }>;

export const journalEntryNotFound = (id: JournalEntryId): JournalEntryNotFound => ({
  kind: "JournalEntryNotFound",
  id,
});
