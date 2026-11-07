import { Result } from "@praha/byethrow";
import type { AdvanceMode } from "../domain/advance-mode.ts";
import type { DeletedJournalEntry, JournalEntry, JournalEntryId } from "../domain/journal-entry.ts";
import type { SessionId, SessionSnapshot } from "../domain/session.ts";
import type { SyncMessage } from "../domain/sync-message.ts";
import type { DeletedTag } from "../domain/tag.ts";
import type { DecisionUnavailable, TaskJudgments } from "../domain/task-decision.ts";
import type { TaskSetting } from "../domain/task-setting.ts";
import type { CompletedTask, DeletedTask, Task } from "../domain/task.ts";
import {
  changeAdvanceMode,
  type AdvanceModeChangeResult,
  type ChangeAdvanceModeDeps,
  type ChangeAdvanceModeError,
} from "./change-advance-mode.ts";
import {
  changeTaskSetting,
  type ChangeTaskSettingDeps,
  type ChangeTaskSettingError,
} from "./change-task-setting.ts";
import { completeTask, type CompleteTaskDeps, type CompleteTaskError } from "./complete-task.ts";
import {
  finishCompletionFromJournal,
  type FinishCompletionDeps,
} from "./complete-tasks-from-journal.ts";
import { createTask, type CreateTaskDeps, type CreateTaskError } from "./create-task.ts";
import {
  deleteJournalEntry,
  type DeleteJournalEntryDeps,
  type DeleteJournalEntryError,
} from "./delete-journal-entry.ts";
import { deleteTag, type DeleteTagDeps, type DeleteTagError } from "./delete-tag.ts";
import { deleteTask, type DeleteTaskDeps, type DeleteTaskError } from "./delete-task.ts";
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
import { renameTask, type RenameTaskDeps, type RenameTaskError } from "./rename-task.ts";
import { reopenTask, type ReopenTaskDeps, type ReopenTaskError } from "./reopen-task.ts";
import { startSession, type StartSessionDeps, type StartSessionError } from "./start-session.ts";
import {
  writeJournalEntry,
  type WriteJournalEntryDeps,
  type WriteJournalEntryError,
} from "./write-journal-entry.ts";

/** 書き込みの結果と、その書き込みのあとで他の画面へ知らせる同期メッセージ */
export type Executed<T> = Readonly<{ value: T; messages: ReadonlyArray<SyncMessage> }>;

const withMessages =
  <T>(messagesOf: (value: T) => ReadonlyArray<SyncMessage>) =>
  (value: T): Executed<T> => ({ value, messages: messagesOf(value) });

const sessionChanged = (snapshot: SessionSnapshot): ReadonlyArray<SyncMessage> => [
  { kind: "SessionChanged", snapshot },
];

export const startSessionCommand =
  (deps: StartSessionDeps) =>
  (
    raw: unknown,
    now: Date,
    newSessionId: SessionId,
  ): Result.Result<Executed<SessionSnapshot>, StartSessionError> =>
    Result.pipe(
      startSession(deps)(raw, now, newSessionId),
      Result.map(withMessages(sessionChanged)),
    );

export const operateSessionCommand =
  (deps: OperateSessionDeps) =>
  (raw: unknown, now: Date): Result.Result<Executed<SessionSnapshot>, OperateSessionError> =>
    Result.pipe(operateSession(deps)(raw, now), Result.map(withMessages(sessionChanged)));

/** 記入で自動終了の時刻が延びるので、書いたあとのスナップショットもあわせて知らせる（ADR 0012） */
export const writeJournalEntryCommand =
  (deps: WriteJournalEntryDeps) =>
  (raw: unknown, now: Date): Result.Result<Executed<JournalEntry>, WriteJournalEntryError> =>
    Result.pipe(
      writeJournalEntry(deps)(raw, now),
      Result.map(
        withMessages((entry) => [
          { kind: "JournalEntrySaved", entry },
          { kind: "SessionChanged", snapshot: getCurrentSession(deps)(now) },
        ]),
      ),
    );

export const editJournalEntryCommand =
  (deps: EditJournalEntryDeps) =>
  (
    rawId: unknown,
    raw: unknown,
    now: Date,
  ): Result.Result<Executed<JournalEntry>, EditJournalEntryError> =>
    Result.pipe(
      editJournalEntry(deps)(rawId, raw, now),
      Result.map(withMessages((entry) => [{ kind: "JournalEntrySaved", entry }])),
    );

export const deleteJournalEntryCommand =
  (deps: DeleteJournalEntryDeps) =>
  (
    rawId: unknown,
    now: Date,
  ): Result.Result<Executed<DeletedJournalEntry>, DeleteJournalEntryError> =>
    Result.pipe(
      deleteJournalEntry(deps)(rawId, now),
      Result.map(withMessages((deleted) => [{ kind: "JournalEntryDeleted", deleted }])),
    );

/** 書き換えた記入は知らせない。削除したタグと付け替え先を送り、画面が同じ削除を当てる（ADR 0017） */
export const deleteTagCommand =
  (deps: DeleteTagDeps) =>
  (rawName: unknown, raw: unknown): Result.Result<Executed<DeletedTag>, DeleteTagError> =>
    Result.pipe(
      deleteTag(deps)(rawName, raw),
      Result.map(withMessages((deleted) => [{ kind: "TagDeleted", deleted }])),
    );

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

export const changeAdvanceModeCommand =
  (deps: ChangeAdvanceModeDeps) =>
  (raw: unknown, now: Date): Result.Result<Executed<AdvanceMode>, ChangeAdvanceModeError> =>
    Result.pipe(
      changeAdvanceMode(deps)(raw, now),
      Result.map((changed) => ({ value: changed.mode, messages: advanceModeMessages(changed) })),
    );

export const changeTaskSettingCommand =
  (deps: ChangeTaskSettingDeps) =>
  (raw: unknown): Result.Result<Executed<TaskSetting>, ChangeTaskSettingError> =>
    Result.pipe(
      changeTaskSetting(deps)(raw),
      Result.map((changed) => ({
        value: changed.setting,
        messages:
          changed.kind === "Changed"
            ? [{ kind: "TaskSettingChanged", setting: changed.setting }]
            : [],
      })),
    );

const taskSaved = (task: Task): ReadonlyArray<SyncMessage> => [{ kind: "TaskSaved", task }];

export const createTaskCommand =
  (deps: CreateTaskDeps) =>
  (raw: unknown, now: Date): Result.Result<Executed<Task>, CreateTaskError> =>
    Result.pipe(createTask(deps)(raw, now), Result.map(withMessages(taskSaved)));

export const renameTaskCommand =
  (deps: RenameTaskDeps) =>
  (rawId: unknown, raw: unknown, now: Date): Result.Result<Executed<Task>, RenameTaskError> =>
    Result.pipe(renameTask(deps)(rawId, raw, now), Result.map(withMessages(taskSaved)));

export const completeTaskCommand =
  (deps: CompleteTaskDeps) =>
  (rawId: unknown, now: Date): Result.Result<Executed<Task>, CompleteTaskError> =>
    Result.pipe(completeTask(deps)(rawId, now), Result.map(withMessages(taskSaved)));

export const reopenTaskCommand =
  (deps: ReopenTaskDeps) =>
  (rawId: unknown, now: Date): Result.Result<Executed<Task>, ReopenTaskError> =>
    Result.pipe(reopenTask(deps)(rawId, now), Result.map(withMessages(taskSaved)));

export const deleteTaskCommand =
  (deps: DeleteTaskDeps) =>
  (rawId: unknown): Result.Result<Executed<DeletedTask>, DeleteTaskError> =>
    Result.pipe(
      deleteTask(deps)(rawId),
      Result.map(withMessages((deleted) => [{ kind: "TaskDeleted", deleted }])),
    );

/** ジャーナルからの完了（GLOSSARY）で完了にしたタスクを、1件ずつ全接続へ知らせる（ADR 0026） */
export const finishCompletionFromJournalCommand =
  (deps: FinishCompletionDeps) =>
  (
    entryId: JournalEntryId,
    decision: Result.Result<TaskJudgments, DecisionUnavailable>,
    now: Date,
  ): Executed<ReadonlyArray<CompletedTask>> =>
    withMessages((completed: ReadonlyArray<CompletedTask>) => completed.flatMap(taskSaved))(
      finishCompletionFromJournal(deps)(entryId, decision, now),
    );
