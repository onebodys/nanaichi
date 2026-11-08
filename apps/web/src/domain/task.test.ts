import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { goldenCases } from "../testing/golden.ts";
import { parsedBy, uuid, type Parsed } from "../testing/golden-values.ts";
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

const taskId = (n: number) => v.parse(TaskId.schema, uuid(n));
const entryId = v.parse(JournalEntryId.schema, uuid(901));
const title = (text: string) => v.parse(TaskTitle.schema, text);
const probability = (value: number) => v.parse(Probability.schema, value);
const judgment = (n: number, value: number): TaskJudgment => ({
  taskId: taskId(n),
  probability: probability(value),
});

/** 場面の入力は、実装の関数で作らずに書く */
const openTask = (n: number): OpenTask => ({
  kind: "Open",
  id: taskId(n),
  title: title(`タスク${n}`),
  createdAt: NOW,
  updatedAt: NOW,
});

const completedManually = (n: number, minutes: number): CompletedTask => ({
  kind: "Completed",
  id: taskId(n),
  title: title(`タスク${n}`),
  createdAt: NOW,
  updatedAt: later(minutes),
  completedAt: later(minutes),
  completion: { kind: "Manual" },
});

goldenCases(
  "Task.create",
  (input: Readonly<{ id: TaskId; title: TaskTitle; now: Date }>) =>
    Task.create(input.id, input.title, input.now),
  [
    {
      name: "作ったタスクは未完了で、作った時刻と更新した時刻が同じ",
      input: { id: taskId(1), title: title("README の更新"), now: NOW },
      expected: {
        kind: "Open",
        id: taskId(1),
        title: title("README の更新"),
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  ],
);

const parseTaskTitle: (input: Readonly<{ value: unknown }>) => Parsed<string> = parsedBy(
  TaskTitle.schema,
);

goldenCases("TaskTitle.parse", parseTaskTitle, [
  {
    name: "タイトルの前後の空白は落とす",
    input: { value: "  README の更新\n" },
    expected: { kind: "Success", value: "README の更新" },
  },
  {
    name: "タイトルが空文字のタスクは作れない",
    input: { value: "" },
    expected: { kind: "Failure", error: { kind: "Invalid" } },
  },
  {
    name: "タイトルが空白だけのタスクは作れない",
    input: { value: "  \n " },
    expected: { kind: "Failure", error: { kind: "Invalid" } },
  },
  {
    name: "タイトルが201文字のタスクは作れない",
    input: { value: "あ".repeat(201) },
    expected: { kind: "Failure", error: { kind: "Invalid" } },
  },
]);

goldenCases(
  "Task.rename",
  (input: Readonly<{ task: OpenTask | CompletedTask; title: TaskTitle; now: Date }>) =>
    Task.rename(input.task, input.title, input.now),
  [
    {
      name: "タイトルを変えると更新した時刻だけが進み、完了のしかたは変わらない",
      input: { task: completedManually(1, 1), title: title("新しいタイトル"), now: later(2) },
      expected: {
        kind: "Completed",
        id: taskId(1),
        title: title("新しいタイトル"),
        createdAt: NOW,
        updatedAt: later(2),
        completedAt: later(1),
        completion: { kind: "Manual" },
      },
    },
  ],
);

goldenCases(
  "Task.complete",
  (input: Readonly<{ task: OpenTask; completion: CompletedTask["completion"]; now: Date }>) =>
    Task.complete(input.task, input.completion, input.now),
  [
    {
      name: "手動で完了にすると、完了した時刻と完了のしかたが付く",
      input: { task: openTask(1), completion: { kind: "Manual" }, now: later(5) },
      expected: {
        kind: "Completed",
        id: taskId(1),
        title: title("タスク1"),
        createdAt: NOW,
        updatedAt: later(5),
        completedAt: later(5),
        completion: { kind: "Manual" },
      },
    },
  ],
);

goldenCases(
  "Task.reopen",
  (input: Readonly<{ task: CompletedTask; now: Date }>) => Task.reopen(input.task, input.now),
  [
    {
      name: "完了したタスクを再開すると未完了に戻り、完了した時刻と完了のしかたは消える",
      input: { task: completedManually(1, 5), now: later(6) },
      expected: {
        kind: "Open",
        id: taskId(1),
        title: title("タスク1"),
        createdAt: NOW,
        updatedAt: later(6),
      },
    },
  ],
);

const fromJournal = (n: number, value: number): CompletedTask => ({
  kind: "Completed",
  id: taskId(n),
  title: title(`タスク${n}`),
  createdAt: NOW,
  updatedAt: later(10),
  completedAt: later(10),
  completion: { kind: "FromJournal", entryId, probability: probability(value) },
});

goldenCases(
  "Task.completedByJournal",
  (
    input: Readonly<{
      tasks: ReadonlyArray<OpenTask | CompletedTask>;
      judgments: ReadonlyArray<TaskJudgment>;
      entryId: JournalEntryId;
      now: Date;
    }>,
  ) => Task.completedByJournal(input.tasks, input.judgments, input.entryId, input.now),
  [
    {
      name: "確率がちょうどしきい値の 0.9 のタスクは完了にする",
      input: { tasks: [openTask(1)], judgments: [judgment(1, 0.9)], entryId, now: later(10) },
      expected: [fromJournal(1, 0.9)],
    },
    {
      name: "確率がしきい値に届かないタスクは完了にしない",
      input: { tasks: [openTask(1)], judgments: [judgment(1, 0.89)], entryId, now: later(10) },
      expected: [],
    },
    {
      name: "しきい値以上のタスクだけを完了にし、ほかのタスクは触らない",
      input: {
        tasks: [openTask(1), openTask(2), openTask(3)],
        judgments: [judgment(1, 0.96), judgment(2, 0.05), judgment(3, 0.94)],
        entryId,
        now: later(10),
      },
      expected: [fromJournal(1, 0.96), fromJournal(3, 0.94)],
    },
    {
      name: "すでに完了しているタスクは確率が高くても触らない",
      input: {
        tasks: [completedManually(1, 1)],
        judgments: [judgment(1, 0.99)],
        entryId,
        now: later(10),
      },
      expected: [],
    },
    {
      name: "答えのなかったタスクは完了にしない",
      input: {
        tasks: [openTask(1), openTask(2)],
        judgments: [judgment(1, 0.95)],
        entryId,
        now: later(10),
      },
      expected: [fromJournal(1, 0.95)],
    },
    {
      name: "知らないタスクへの答えは無視する",
      input: { tasks: [openTask(1)], judgments: [judgment(9, 0.99)], entryId, now: later(10) },
      expected: [],
    },
    {
      name: "同じタスクに答えが複数あれば、いちばん高い確率を使う",
      input: {
        tasks: [openTask(1)],
        judgments: [judgment(1, 0.2), judgment(1, 0.93)],
        entryId,
        now: later(10),
      },
      expected: [fromJournal(1, 0.93)],
    },
  ],
);

describe("自動完了のしきい値", () => {
  test("自動完了のしきい値は 0.9", () => {
    expect(AUTO_COMPLETE_THRESHOLD).toBe(0.9);
  });
});

describe("タスクの応答の検証", () => {
  const parse = schemaResult(TaskJsonSchema);

  test("JSON にした未完了のタスクを、時刻を Date に戻して読める", () => {
    const parsed = parse(JSON.parse(JSON.stringify(openTask(1))));

    expect(parsed).toEqual({ type: "Success", value: openTask(1) });
  });

  test("JSON にしたジャーナルからの完了のタスクを読める", () => {
    const completed = fromJournal(1, 0.96);

    expect(parse(JSON.parse(JSON.stringify(completed)))).toEqual({
      type: "Success",
      value: completed,
    });
  });

  test("完了した時刻のない完了のタスクは読めない", () => {
    const { completedAt: _, ...withoutCompletedAt } = completedManually(1, 1);

    expect(parse(JSON.parse(JSON.stringify(withoutCompletedAt))).type).toBe("Failure");
  });
});
