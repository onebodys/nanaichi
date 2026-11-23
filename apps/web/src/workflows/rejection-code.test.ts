import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import type { ApiErrorCode } from "../domain/api-error.ts";
import { JournalEntryId } from "../domain/journal-entry.ts";
import { SessionEventId } from "../domain/session-event.ts";
import { SessionId } from "../domain/session.ts";
import { TagName } from "../domain/tag.ts";
import { TaskId } from "../domain/task.ts";
import { rejectionCodeOf, type WorkflowError } from "./rejection-code.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const cases: ReadonlyArray<Readonly<{ scene: string; error: WorkflowError; code: ApiErrorCode }>> =
  [
    {
      scene: "入力が不正なとき",
      error: { kind: "ValidationError", issues: [] },
      code: "INVALID_REQUEST",
    },
    {
      scene: "タグを同じタグへ付け替えようとしたとき",
      error: { kind: "ReassignToSameTag" },
      code: "INVALID_REQUEST",
    },
    {
      scene: "セッションがあるうちに開始したとき",
      error: { kind: "SessionAlreadyInProgress", sessionId: v.parse(SessionId.schema, uuid(1)) },
      code: "SESSION_ALREADY_IN_PROGRESS",
    },
    {
      scene: "セッションの外で操作したとき",
      error: { kind: "NoSessionInProgress" },
      code: "NO_SESSION_IN_PROGRESS",
    },
    {
      scene: "休憩中に中断したとき",
      error: { kind: "OperationRejected", operation: "Abort", at: new Date(0), during: "Break" },
      code: "OPERATION_REJECTED",
    },
    {
      scene: "記録済みの操作イベントと同じ ID で別の操作が届いたとき",
      error: { kind: "EventIdConflict", eventId: v.parse(SessionEventId.schema, uuid(2)) },
      code: "EVENT_ID_CONFLICT",
    },
    {
      scene: "タグの種類が上限を超えるとき",
      error: { kind: "TagLimitExceeded", limit: 20 },
      code: "TAG_LIMIT_EXCEEDED",
    },
    {
      scene: "ジャーナル記入が記録されていないとき",
      error: { kind: "JournalEntryNotFound", id: v.parse(JournalEntryId.schema, uuid(3)) },
      code: "JOURNAL_ENTRY_NOT_FOUND",
    },
    {
      scene: "タグがどの記入にもついていないとき",
      error: { kind: "TagNotFound", name: v.parse(TagName.schema, "仕事") },
      code: "TAG_NOT_FOUND",
    },
    {
      scene: "タスクが記録されていないとき",
      error: { kind: "TaskNotFound", id: v.parse(TaskId.schema, uuid(4)) },
      code: "TASK_NOT_FOUND",
    },
  ];

describe("拒否の種類", () => {
  test.each(cases)("$scene、$code として断る", ({ error, code }) => {
    expect(rejectionCodeOf(error)).toBe(code);
  });
});
