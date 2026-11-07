import type { ApiErrorCode } from "../domain/api-error.ts";
import type { DeleteJournalEntryError } from "./delete-journal-entry.ts";
import type { CompleteTaskError } from "./complete-task.ts";
import type { DeleteTagError } from "./delete-tag.ts";
import type { DeleteTaskError } from "./delete-task.ts";
import type { EditJournalEntryError } from "./edit-journal-entry.ts";
import type { GetTimelineError } from "./get-timeline.ts";
import type { OperateSessionError } from "./operate-session.ts";
import type { RenameTaskError } from "./rename-task.ts";
import type { ReopenTaskError } from "./reopen-task.ts";
import type { StartSessionError } from "./start-session.ts";
import type { WriteJournalEntryError } from "./write-journal-entry.ts";

export type WorkflowError =
  | StartSessionError
  | OperateSessionError
  | WriteJournalEntryError
  | EditJournalEntryError
  | DeleteJournalEntryError
  | DeleteTagError
  | GetTimelineError
  | RenameTaskError
  | CompleteTaskError
  | ReopenTaskError
  | DeleteTaskError;

/** 想定内の失敗を、画面が扱いを決める拒否の種類にする */
export const rejectionCodeOf = (error: WorkflowError): ApiErrorCode => {
  switch (error.kind) {
    case "ValidationError":
    case "ReassignToSameTag":
      return "INVALID_REQUEST";
    case "SessionAlreadyInProgress":
      return "SESSION_ALREADY_IN_PROGRESS";
    case "NoSessionInProgress":
      return "NO_SESSION_IN_PROGRESS";
    case "OperationRejected":
      return "OPERATION_REJECTED";
    case "EventIdConflict":
      return "EVENT_ID_CONFLICT";
    case "TagLimitExceeded":
      return "TAG_LIMIT_EXCEEDED";
    case "JournalEntryNotFound":
      return "JOURNAL_ENTRY_NOT_FOUND";
    case "TagNotFound":
      return "TAG_NOT_FOUND";
    case "TaskNotFound":
      return "TASK_NOT_FOUND";
  }
};
