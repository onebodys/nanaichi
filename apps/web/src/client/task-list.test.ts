import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { JournalEntryId } from "../domain/journal-entry.ts";
import { Probability, Task, TaskId, TaskTitle, type OpenTask } from "../domain/task.ts";
import { completionLabelOf, groupTasks, removeTask, upsertTask } from "./task-list.ts";

const NOW = new Date(Date.UTC(2026, 9, 17, 0, 0, 0));
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const taskId = (n: number) =>
  v.parse(TaskId.schema, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const openTask = (n: number, createdAt = later(n)): OpenTask =>
  Task.create(taskId(n), v.parse(TaskTitle.schema, `タスク${n}`), createdAt);

describe("タスクの一覧への反映", () => {
  test("知らないタスクは一覧の末尾に足す", () => {
    expect(upsertTask([openTask(1)], openTask(2))).toEqual([openTask(1), openTask(2)]);
  });

  test("同じ ID のタスクは新しい内容で置き換える", () => {
    const completed = Task.complete(openTask(1), { kind: "Manual" }, later(10));

    expect(upsertTask([openTask(1)], completed)).toEqual([completed]);
  });

  test("古い内容が遅れて届いても、新しい内容を戻さない", () => {
    const completed = Task.complete(openTask(1), { kind: "Manual" }, later(10));

    expect(upsertTask([completed], openTask(1))).toEqual([completed]);
  });

  test("削除したタスクは一覧から外す", () => {
    expect(removeTask([openTask(1), openTask(2)], taskId(1))).toEqual([openTask(2)]);
  });
});

describe("タスクの並び", () => {
  test("未完了は作った順、完了は完了した新しい順に並べる", () => {
    const first = Task.complete(openTask(1), { kind: "Manual" }, later(20));
    const second = Task.complete(openTask(2), { kind: "Manual" }, later(30));

    const { open, completed } = groupTasks([second, openTask(4), first, openTask(3)]);

    expect(open.map(({ id }) => id)).toEqual([taskId(3), taskId(4)]);
    expect(completed.map(({ id }) => id)).toEqual([taskId(2), taskId(1)]);
  });
});

describe("完了のしかたの表示", () => {
  test("ジャーナルから完了したタスクには、確率をパーセントで出す", () => {
    const completed = Task.complete(
      openTask(1),
      {
        kind: "FromJournal",
        entryId: v.parse(JournalEntryId.schema, "00000000-0000-4000-8000-0000000000e1"),
        probability: v.parse(Probability.schema, 0.955),
      },
      later(10),
    );

    expect(completionLabelOf(completed)).toBe("ジャーナルから完了 (96%)");
  });

  test("自分で完了にしたタスクには何も出さない", () => {
    expect(completionLabelOf(Task.complete(openTask(1), { kind: "Manual" }, later(10)))).toBe(
      undefined,
    );
  });
});
