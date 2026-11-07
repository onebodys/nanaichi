import { Result } from "@praha/byethrow";
import { describe, expect, test, vi } from "vite-plus/test";
import * as v from "valibot";
import { JournalEntryBody, JournalEntryId, type JournalEntry } from "../domain/journal-entry.ts";
import { SessionId } from "../domain/session.ts";
import { Task, TaskId, TaskTitle } from "../domain/task.ts";
import type { TaskSetting } from "../domain/task-setting.ts";
import { prepareCompletionFromJournal } from "./complete-tasks-from-journal.ts";

const NOW = new Date(Date.UTC(2026, 9, 17, 0, 0, 0));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const entry: JournalEntry = {
  id: v.parse(JournalEntryId.schema, uuid(1)),
  sessionId: v.parse(SessionId.schema, uuid(2)),
  body: v.parse(JournalEntryBody.schema, "ログイン画面のバグ修正が完了した"),
  tags: [],
  writtenAt: NOW,
  updatedAt: NOW,
  writtenDuring: { kind: "Journal", round: 1, setNumber: 1 },
};
const openTask = Task.create(
  v.parse(TaskId.schema, uuid(3)),
  v.parse(TaskTitle.schema, "ログイン画面のバグ修正"),
  NOW,
);

const depsWith = (setting: TaskSetting) => ({
  loadTaskSetting: () => setting,
  listTasks: vi.fn(() => [openTask]),
  hasDecisionRun: vi.fn(() => false),
  countDecisionRunsSince: vi.fn(() => 0),
  startDecisionRun: vi.fn(),
});

describe("ジャーナルからの完了を始める前の判断", () => {
  test("ToDo の設定が無効なら、タスクも判断の回数も読まず、判断を始めたとも記録しない", () => {
    const deps = depsWith({ kind: "Disabled" });

    const result = prepareCompletionFromJournal(deps)(entry, NOW);

    expect(result).toEqual(Result.fail({ kind: "TasksDisabled" }));
    expect(deps.hasDecisionRun).not.toHaveBeenCalled();
    expect(deps.listTasks).not.toHaveBeenCalled();
    expect(deps.countDecisionRunsSince).not.toHaveBeenCalled();
    expect(deps.startDecisionRun).not.toHaveBeenCalled();
  });

  test("ToDo の設定が有効なら、未完了のタスクを判断モデルに渡すものとして用意し、判断を始めたと記録する", () => {
    const deps = depsWith({ kind: "Enabled" });

    const result = prepareCompletionFromJournal(deps)(entry, NOW);

    expect(result).toEqual(
      Result.succeed({ entryId: entry.id, body: entry.body, openTasks: [openTask] }),
    );
    expect(deps.startDecisionRun).toHaveBeenCalledWith(entry.id, NOW);
  });
});
