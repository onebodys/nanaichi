import { Result } from "@praha/byethrow";
import type { AdvanceMode } from "../domain/advance-mode.ts";
import type { DeletedJournalEntry, JournalEntry } from "../domain/journal-entry.ts";
import type { SessionId, SessionSnapshot } from "../domain/session.ts";
import type { SyncMessage } from "../domain/sync-message.ts";
import type { DeletedTag } from "../domain/tag.ts";
import {
  changeAdvanceMode,
  type AdvanceModeChangeResult,
  type ChangeAdvanceModeDeps,
  type ChangeAdvanceModeError,
} from "./change-advance-mode.ts";
import {
  deleteJournalEntry,
  type DeleteJournalEntryDeps,
  type DeleteJournalEntryError,
} from "./delete-journal-entry.ts";
import { deleteTag, type DeleteTagDeps, type DeleteTagError } from "./delete-tag.ts";
import {
  editJournalEntry,
  type EditJournalEntryDeps,
  type EditJournalEntryError,
} from "./edit-journal-entry.ts";
import { getCurrentSession } from "./get-current-session.ts";
import {
  operateSession,
  type OperateSessionDeps,
  type OperateSessionError,
} from "./operate-session.ts";
import { startSession, type StartSessionDeps, type StartSessionError } from "./start-session.ts";
import {
  writeJournalEntry,
  type WriteJournalEntryDeps,
  type WriteJournalEntryError,
} from "./write-journal-entry.ts";

/**
 * 書き込みの結果と、その書き込みのあとで他の画面へ知らせる同期メッセージ。
 *
 * どのメッセージを送るかは記録先によらず同じ方針なので、ここで決める。送るのは記録先の側
 * （UserDO の WebSocket、この端末なら他のタブ）で、失敗のときは `messages` は空。
 */
export type Executed<T, E> = Readonly<{
  result: Result.Result<T, E>;
  messages: ReadonlyArray<SyncMessage>;
}>;

const executed = <T, E>(
  result: Result.Result<T, E>,
  messagesOf: (value: T) => ReadonlyArray<SyncMessage>,
): Executed<T, E> => ({
  result,
  messages: Result.isSuccess(result) ? messagesOf(result.value) : [],
});

const sessionChanged = (snapshot: SessionSnapshot): ReadonlyArray<SyncMessage> => [
  { kind: "SessionChanged", snapshot },
];

export const startSessionCommand =
  (deps: StartSessionDeps) =>
  (
    raw: unknown,
    now: Date,
    newSessionId: SessionId,
  ): Executed<SessionSnapshot, StartSessionError> =>
    executed(startSession(deps)(raw, now, newSessionId), sessionChanged);

export const operateSessionCommand =
  (deps: OperateSessionDeps) =>
  (raw: unknown, now: Date): Executed<SessionSnapshot, OperateSessionError> =>
    executed(operateSession(deps)(raw, now), sessionChanged);

/**
 * 記入で自動終了の時刻が延びるので、書いたあとのスナップショットもあわせて知らせる（ADR 0012）。
 * スナップショットは書き込みのあとでないと読めないので、同じ呼び出しの中で deps から読む。
 */
export const writeJournalEntryCommand =
  (deps: WriteJournalEntryDeps) =>
  (raw: unknown, now: Date): Executed<JournalEntry, WriteJournalEntryError> =>
    executed(writeJournalEntry(deps)(raw, now), (entry) => [
      { kind: "JournalEntrySaved", entry },
      { kind: "SessionChanged", snapshot: getCurrentSession(deps)(now) },
    ]);

export const editJournalEntryCommand =
  (deps: EditJournalEntryDeps) =>
  (rawId: unknown, raw: unknown, now: Date): Executed<JournalEntry, EditJournalEntryError> =>
    executed(editJournalEntry(deps)(rawId, raw, now), (entry) => [
      { kind: "JournalEntrySaved", entry },
    ]);

export const deleteJournalEntryCommand =
  (deps: DeleteJournalEntryDeps) =>
  (rawId: unknown, now: Date): Executed<DeletedJournalEntry, DeleteJournalEntryError> =>
    executed(deleteJournalEntry(deps)(rawId, now), (deleted) => [
      { kind: "JournalEntryDeleted", deleted },
    ]);

/** 書き換えた記入は知らせない。削除したタグと付け替え先を送り、画面が同じ削除を当てる（ADR 0017） */
export const deleteTagCommand =
  (deps: DeleteTagDeps) =>
  (rawName: unknown, raw: unknown): Executed<DeletedTag, DeleteTagError> =>
    executed(deleteTag(deps)(rawName, raw), (deleted) => [{ kind: "TagDeleted", deleted }]);

const advanceModeMessages = (changed: AdvanceModeChangeResult): ReadonlyArray<SyncMessage> => {
  switch (changed.kind) {
    case "Unchanged":
      return [];
    case "Changed":
      return [
        { kind: "AdvanceModeChanged", mode: changed.mode },
        ...(changed.snapshot.kind === "Session"
          ? [{ kind: "SessionChanged", snapshot: changed.snapshot } as const]
          : []),
      ];
  }
};

/** 変えなかったときは何も知らせない。進行中のセッションがあるときだけ、新しいスナップショットも送る（ADR 0016） */
export const changeAdvanceModeCommand =
  (deps: ChangeAdvanceModeDeps) =>
  (raw: unknown, now: Date): Executed<AdvanceMode, ChangeAdvanceModeError> => {
    const result = changeAdvanceMode(deps)(raw, now);
    return {
      result: Result.pipe(
        result,
        Result.map(({ mode }) => mode),
      ),
      messages: Result.isSuccess(result) ? advanceModeMessages(result.value) : [],
    };
  };
