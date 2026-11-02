import type { ApiErrorCode } from "../domain/api-error.ts";
import type { DeleteJournalEntryError } from "./delete-journal-entry.ts";
import type { DeleteTagError } from "./delete-tag.ts";
import type { EditJournalEntryError } from "./edit-journal-entry.ts";
import type { GetTimelineError } from "./get-timeline.ts";
import type { OperateSessionError } from "./operate-session.ts";
import type { StartSessionError } from "./start-session.ts";
import type { WriteJournalEntryError } from "./write-journal-entry.ts";

/** 画面から呼ぶワークフローの想定内の失敗すべて */
export type WorkflowError =
  | StartSessionError
  | OperateSessionError
  | WriteJournalEntryError
  | EditJournalEntryError
  | DeleteJournalEntryError
  | DeleteTagError
  | GetTimelineError;

/**
 * 想定内の失敗を、画面が扱いを決める拒否の種類にする。
 * サーバーもこの端末の記録先も同じ対応を使う。HTTP のステータスなど届け方はここでは決めない。
 */
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
  }
};
