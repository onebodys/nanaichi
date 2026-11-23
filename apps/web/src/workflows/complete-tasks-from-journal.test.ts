import { Result } from "@praha/byethrow";
import { describe, expect, test, vi } from "vite-plus/test";
import * as v from "valibot";
import { JournalEntryBody, JournalEntryId, type JournalEntry } from "../domain/journal-entry.ts";
import { SessionId } from "../domain/session.ts";
import { Task, TaskId, TaskTitle } from "../domain/task.ts";
import type { TaskSetting } from "../domain/task-setting.ts";
import { DAILY_DECISION_LIMIT } from "../domain/task-decision.ts";
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

  test("未完了のタスクがなければ、判断を始めたと記録せず NoOpenTasks を返す", () => {
    const deps = { ...depsWith({ kind: "Enabled" }), listTasks: vi.fn(() => []) };

    const result = prepareCompletionFromJournal(deps)(entry, NOW);

    expect(result).toEqual(Result.fail({ kind: "NoOpenTasks" }));
    expect(deps.startDecisionRun).not.toHaveBeenCalled();
  });

  test("今日の判断の回数が上限に達していれば、判断を始めたと記録せず DailyLimitReached を返す", () => {
    const deps = {
      ...depsWith({ kind: "Enabled" }),
      countDecisionRunsSince: vi.fn(() => DAILY_DECISION_LIMIT),
    };

    const result = prepareCompletionFromJournal(deps)(entry, NOW);

    expect(result).toEqual(Result.fail({ kind: "DailyLimitReached" }));
    expect(deps.startDecisionRun).not.toHaveBeenCalled();
  });

  test("今日の判断の回数が上限に1回足りなければ、まだ判断を始められる", () => {
    const deps = {
      ...depsWith({ kind: "Enabled" }),
      countDecisionRunsSince: vi.fn(() => DAILY_DECISION_LIMIT - 1),
    };

    const result = prepareCompletionFromJournal(deps)(entry, NOW);

    expect(Result.isSuccess(result)).toBe(true);
    expect(deps.startDecisionRun).toHaveBeenCalledWith(entry.id, NOW);
  });

  test("すでに判断を始めた記入なら、タスクを読まず、判断を始めたと記録し直さず AlreadyDecided を返す", () => {
    const deps = { ...depsWith({ kind: "Enabled" }), hasDecisionRun: vi.fn(() => true) };

    const result = prepareCompletionFromJournal(deps)(entry, NOW);

    expect(result).toEqual(Result.fail({ kind: "AlreadyDecided", entryId: entry.id }));
    expect(deps.hasDecisionRun).toHaveBeenCalledWith(entry.id);
    expect(deps.listTasks).not.toHaveBeenCalled();
    expect(deps.startDecisionRun).not.toHaveBeenCalled();
  });

  test("判断モデルには未完了のタスクだけを、新しく作った順に渡す", () => {
    const newer = Task.create(
      v.parse(TaskId.schema, uuid(4)),
      v.parse(TaskTitle.schema, "請求書を送る"),
      NOW,
    );
    const completed = Task.complete(
      Task.create(v.parse(TaskId.schema, uuid(5)), v.parse(TaskTitle.schema, "牛乳を買う"), NOW),
      { kind: "Manual" },
      NOW,
    );
    const deps = {
      ...depsWith({ kind: "Enabled" }),
      listTasks: vi.fn(() => [openTask, completed, newer]),
    };

    const result = prepareCompletionFromJournal(deps)(entry, NOW);

    expect(Result.unwrap(result).openTasks).toEqual([newer, openTask]);
  });

  test("完了したタスクしかなければ、判断を始めたと記録せず NoOpenTasks を返す", () => {
    const completed = Task.complete(openTask, { kind: "Manual" }, NOW);
    const deps = { ...depsWith({ kind: "Enabled" }), listTasks: vi.fn(() => [completed]) };

    const result = prepareCompletionFromJournal(deps)(entry, NOW);

    expect(result).toEqual(Result.fail({ kind: "NoOpenTasks" }));
    expect(deps.startDecisionRun).not.toHaveBeenCalled();
  });
});
