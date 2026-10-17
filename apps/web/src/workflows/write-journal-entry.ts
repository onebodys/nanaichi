import { Result } from "@praha/byethrow";
import * as v from "valibot";
import {
  JournalEntry,
  JournalEntryBody,
  JournalEntryId,
  type FindJournalEntry,
  type NoSessionInProgress,
  type SaveJournalEntry,
} from "../domain/journal-entry.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import { Session } from "../domain/session.ts";
import { loadOpenSession, type OpenSessionDeps } from "./auto-end-session.ts";
import { journalEntryNotFound, type JournalEntryNotFound } from "./journal-entry-not-found.ts";

/**
 * `POST /api/journal-entries` の本文。
 *
 * - `id`: ジャーナル記入の ID（クライアントが発行する、ADR 0010）
 * - `body`: 本文。前後の空白を落として空なら書けない
 */
const WriteJournalEntryInputSchema = v.object({
  id: JournalEntryId.schema,
  body: JournalEntryBody.schema,
});
type WriteJournalEntryInput = v.InferOutput<typeof WriteJournalEntryInputSchema>;

export type WriteJournalEntryError = ValidationError | NoSessionInProgress | JournalEntryNotFound;

export type WriteJournalEntryDeps = OpenSessionDeps &
  Readonly<{
    findJournalEntry: FindJournalEntry;
    saveJournalEntry: SaveJournalEntry;
  }>;

const parseInput = schemaResult(WriteJournalEntryInputSchema);

const ensureSessionInProgress = (
  open: Session | undefined,
): Result.Result<Session, NoSessionInProgress> =>
  open === undefined ? Result.fail({ kind: "NoSessionInProgress" }) : Result.succeed(open);

/**
 * ジャーナル記入を書く（GLOSSARY の「ジャーナル記入」）。
 *
 * 入力の検証 → 同じ ID の記入が記録済みなら再送として扱う → 現在のセッションの読み込み
 * → 書いた時点のタイマーの状態に紐付けて書く → 記録。セッションの外では書けない。
 * 自動終了の時刻を過ぎたセッションは、読み込むときに閉じる（`loadOpenSession`）ので書けない。
 */
export const writeJournalEntry =
  (deps: WriteJournalEntryDeps) =>
  (raw: unknown, now: Date): Result.Result<JournalEntry, WriteJournalEntryError> => {
    const write = (input: WriteJournalEntryInput) =>
      Result.pipe(
        ensureSessionInProgress(loadOpenSession(deps)(now)),
        Result.andThen((session) =>
          JournalEntry.write({
            id: input.id,
            body: input.body,
            sessionId: session.id,
            state: Session.stateAt(session, now),
            now,
          }),
        ),
        Result.andThrough((entry) => Result.succeed(deps.saveJournalEntry(entry))),
      );

    return Result.pipe(
      parseInput(raw),
      Result.andThen((input): Result.Result<JournalEntry, WriteJournalEntryError> => {
        const recorded = deps.findJournalEntry(input.id);
        if (recorded === undefined) {
          return write(input);
        }
        // 通信のやり直しで同じ記入が2回届いたら、1回目に記録したものを返す（ADR 0010）
        return recorded.kind === "Written"
          ? Result.succeed(recorded.entry)
          : Result.fail(journalEntryNotFound(input.id));
      }),
    );
  };
