import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { JournalEntryId } from "./journal-entry.ts";
import { schemaResult } from "./schema-result.ts";
import {
  AUTO_COMPLETE_THRESHOLD,
  Probability,
  Task,
  TaskId,
  TaskJsonSchema,
  TaskTitle,
  type CompletedTask,
  type OpenTask,
  type TaskJudgment,
} from "./task.ts";

const NOW = new Date(Date.UTC(2026, 9, 17, 0, 0, 0));
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const taskId = (n: number) =>
  v.parse(TaskId.schema, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const entryId = v.parse(JournalEntryId.schema, "00000000-0000-4000-8000-0000000000e1");
const title = (text: string) => v.parse(TaskTitle.schema, text);
const probability = (value: number) => v.parse(Probability.schema, value);
const judgment = (n: number, value: number): TaskJudgment => ({
  taskId: taskId(n),
  probability: probability(value),
});

const openTask = (n: number): OpenTask => Task.create(taskId(n), title(`タスク${n}`), NOW);

describe("タスクの作成とタイトル", () => {
  test("作ったタスクは未完了で、作った時刻と更新した時刻が同じ", () => {
    expect(Task.create(taskId(1), title("README の更新"), NOW)).toEqual({
      kind: "Open",
      id: taskId(1),
      title: "README の更新",
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  test("タイトルの前後の空白は落とす", () => {
    expect(v.parse(TaskTitle.schema, "  README の更新\n")).toBe("README の更新");
  });

  test.each([
    ["空文字", ""],
    ["空白だけ", "  \n "],
    ["201文字", "あ".repeat(201)],
  ])("タイトルが%sのタスクは作れない", (_, text) => {
    expect(v.safeParse(TaskTitle.schema, text).success).toBe(false);
  });

  test("タイトルを変えると更新した時刻だけが進み、完了のしかたは変わらない", () => {
    const completed = Task.complete(openTask(1), { kind: "Manual" }, later(1));

    const renamed = Task.rename(completed, title("新しいタイトル"), later(2));

    expect(renamed).toEqual({
      ...completed,
      title: "新しいタイトル",
      updatedAt: later(2),
    });
  });
});

describe("タスクの完了と再開", () => {
  test("手動で完了にすると、完了した時刻と完了のしかたが付く", () => {
    const completed = Task.complete(openTask(1), { kind: "Manual" }, later(5));

    expect(completed).toMatchObject({
      kind: "Completed",
      createdAt: NOW,
      updatedAt: later(5),
      completedAt: later(5),
      completion: { kind: "Manual" },
    });
  });

  test("完了したタスクを再開すると未完了に戻り、完了した時刻と完了のしかたは消える", () => {
    const completed = Task.complete(openTask(1), { kind: "Manual" }, later(5));

    const reopened = Task.reopen(completed, later(6));

    expect(reopened).toEqual({
      kind: "Open",
      id: taskId(1),
      title: "タスク1",
      createdAt: NOW,
      updatedAt: later(6),
    });
  });
});

describe("ジャーナルからの完了", () => {
  const complete = (tasks: ReadonlyArray<OpenTask | CompletedTask>, judgments: TaskJudgment[]) =>
    Task.completedByJournal(tasks, judgments, entryId, later(10));

  test("自動完了のしきい値は 0.9", () => {
    expect(AUTO_COMPLETE_THRESHOLD).toBe(0.9);
  });

  test("確率がちょうどしきい値の 0.9 のタスクは完了にする", () => {
    const completed = complete([openTask(1)], [judgment(1, 0.9)]);

    expect(completed).toEqual([
      {
        kind: "Completed",
        id: taskId(1),
        title: "タスク1",
        createdAt: NOW,
        updatedAt: later(10),
        completedAt: later(10),
        completion: { kind: "FromJournal", entryId, probability: 0.9 },
      },
    ]);
  });

  test("確率がしきい値に届かないタスクは完了にしない", () => {
    expect(complete([openTask(1)], [judgment(1, 0.89)])).toEqual([]);
  });

  test("しきい値以上のタスクだけを完了にし、ほかのタスクは触らない", () => {
    const completed = complete(
      [openTask(1), openTask(2), openTask(3)],
      [judgment(1, 0.96), judgment(2, 0.05), judgment(3, 0.94)],
    );

    expect(completed.map(({ id }) => id)).toEqual([taskId(1), taskId(3)]);
  });

  test("すでに完了しているタスクは確率が高くても触らない", () => {
    const alreadyCompleted = Task.complete(openTask(1), { kind: "Manual" }, later(1));

    expect(complete([alreadyCompleted], [judgment(1, 0.99)])).toEqual([]);
  });

  test("答えのなかったタスクは完了にしない", () => {
    expect(complete([openTask(1), openTask(2)], [judgment(1, 0.95)]).map(({ id }) => id)).toEqual([
      taskId(1),
    ]);
  });

  test("知らないタスクへの答えは無視する", () => {
    expect(complete([openTask(1)], [judgment(9, 0.99)])).toEqual([]);
  });

  test("同じタスクに答えが複数あれば、いちばん高い確率を使う", () => {
    const completed = complete([openTask(1)], [judgment(1, 0.2), judgment(1, 0.93)]);

    expect(completed).toMatchObject([{ completion: { probability: 0.93 } }]);
  });
});

describe("タスクの応答の検証", () => {
  const parse = schemaResult(TaskJsonSchema);

  test("JSON にした未完了のタスクを、時刻を Date に戻して読める", () => {
    const parsed = parse(JSON.parse(JSON.stringify(openTask(1))));

    expect(parsed).toEqual({ type: "Success", value: openTask(1) });
  });

  test("JSON にしたジャーナルからの完了のタスクを読める", () => {
    const completed = Task.completedByJournal(
      [openTask(1)],
      [judgment(1, 0.96)],
      entryId,
      later(10),
    )[0];

    expect(parse(JSON.parse(JSON.stringify(completed)))).toEqual({
      type: "Success",
      value: completed,
    });
  });

  test("完了した時刻のない完了のタスクは読めない", () => {
    const { completedAt: _, ...withoutCompletedAt } = Task.complete(
      openTask(1),
      { kind: "Manual" },
      later(1),
    );

    expect(parse(JSON.parse(JSON.stringify(withoutCompletedAt))).type).toBe("Failure");
  });
});
