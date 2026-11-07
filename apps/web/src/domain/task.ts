import * as v from "valibot";
import { JournalEntryId } from "./journal-entry.ts";
import { JsonDateSchema } from "./json-date.ts";

/**
 * タスクの ID。クライアントが発行する（ADR 0010 のジャーナル記入と同じ）。
 *
 * 同じ ID のタスクを2回作っても1件しか記録しないことで、通信のやり直しによる二重作成を防ぐ。
 */
const TaskIdSchema = v.pipe(v.string(), v.uuid(), v.brand("TaskId"));
export type TaskId = v.InferOutput<typeof TaskIdSchema>;

export const TaskId = {
  schema: TaskIdSchema,
} as const;

/** タイトルの長さの上限。やることを一言で書く場所なので、長い文章は入れない */
const TITLE_MAX_LENGTH = 200;

/** タスクのタイトル。前後の空白は落とす。空のタスクは作れない */
const TaskTitleSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(TITLE_MAX_LENGTH),
  v.brand("TaskTitle"),
);
export type TaskTitle = v.InferOutput<typeof TaskTitleSchema>;

export const TaskTitle = {
  schema: TaskTitleSchema,
} as const;

/** 判断モデルが答える確率。0 から 1 で、「やり終えた」と言い切れる度合い（GLOSSARY の「判断モデル」） */
const ProbabilitySchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1), v.brand("Probability"));
export type Probability = v.InferOutput<typeof ProbabilitySchema>;

export const Probability = {
  schema: ProbabilitySchema,
} as const;

/** 自動で完了にする確率のしきい値（以上）。これに届かないときは何もしない（ADR 0026） */
export const AUTO_COMPLETE_THRESHOLD = 0.9;

/**
 * 完了のしかた（GLOSSARY の「完了のしかた」）。
 *
 * - `Manual`: ユーザーが自分で完了にした
 * - `FromJournal`: ジャーナル記入から自動で完了にした。もとの記入と、判断モデルが答えた確率を持つ
 */
export type TaskCompletion =
  | Readonly<{ kind: "Manual" }>
  | Readonly<{ kind: "FromJournal"; entryId: JournalEntryId; probability: Probability }>;

/** 未完了のタスク */
export type OpenTask = Readonly<{
  kind: "Open";
  id: TaskId;
  title: TaskTitle;
  createdAt: Date;
  updatedAt: Date;
}>;

/** 完了したタスク。完了した時刻とそのしかたを必ず持つ */
export type CompletedTask = Readonly<{
  kind: "Completed";
  id: TaskId;
  title: TaskTitle;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date;
  completion: TaskCompletion;
}>;

/** タスク（GLOSSARY の「タスク」） */
export type Task = OpenTask | CompletedTask;

/** タスクが記録されていない（ADR 0026） */
export type TaskNotFound = Readonly<{ kind: "TaskNotFound"; id: TaskId }>;

/** 判断モデルが答えた、1つのタスクが「やり終えた」と言える確率 */
export type TaskJudgment = Readonly<{ taskId: TaskId; probability: Probability }>;

export const Task = {
  create: (id: TaskId, title: TaskTitle, now: Date): OpenTask => ({
    kind: "Open",
    id,
    title,
    createdAt: now,
    updatedAt: now,
  }),

  /** タイトルを変える。未完了でも完了でもできる */
  rename: (task: Task, title: TaskTitle, now: Date): Task => ({
    ...task,
    title,
    updatedAt: now,
  }),

  complete: (task: OpenTask, completion: TaskCompletion, now: Date): CompletedTask => ({
    kind: "Completed",
    id: task.id,
    title: task.title,
    createdAt: task.createdAt,
    updatedAt: now,
    completedAt: now,
    completion,
  }),

  /** 完了したタスクを未完了に戻す。完了した時刻とそのしかたは消える */
  reopen: (task: CompletedTask, now: Date): OpenTask => ({
    kind: "Open",
    id: task.id,
    title: task.title,
    createdAt: task.createdAt,
    updatedAt: now,
  }),

  /**
   * 判断モデルの答えから、ジャーナル記入 `entryId` で完了にするタスクを決める（GLOSSARY の「ジャーナルからの完了」）。
   *
   * しきい値（`AUTO_COMPLETE_THRESHOLD`）以上の確率で答えられた、まだ未完了のタスクだけを完了にする。
   * 答えたあとに完了にされた・削除されたタスクや、知らないタスクへの答えは無視する。
   * 同じタスクに答えが複数あれば、いちばん高い確率を使う。
   */
  completedByJournal: (
    tasks: ReadonlyArray<Task>,
    judgments: ReadonlyArray<TaskJudgment>,
    entryId: JournalEntryId,
    now: Date,
  ): ReadonlyArray<CompletedTask> => {
    const highest = new Map<TaskId, Probability>();
    for (const { taskId, probability } of judgments) {
      const known = highest.get(taskId);
      if (known === undefined || probability > known) {
        highest.set(taskId, probability);
      }
    }
    return tasks.flatMap((task) => {
      const probability = highest.get(task.id);
      if (task.kind !== "Open" || probability === undefined) {
        return [];
      }
      return probability >= AUTO_COMPLETE_THRESHOLD
        ? [Task.complete(task, { kind: "FromJournal", entryId, probability }, now)]
        : [];
    });
  },
} as const;

// ---------------------------------------------------------------------------
// API の応答（ADR 0009）。時刻は ISO 8601 の文字列で届くので、Date に戻す
// ---------------------------------------------------------------------------

const TaskCompletionJsonSchema: v.GenericSchema<unknown, TaskCompletion> = v.variant("kind", [
  v.object({ kind: v.literal("Manual") }),
  v.object({
    kind: v.literal("FromJournal"),
    entryId: JournalEntryId.schema,
    probability: ProbabilitySchema,
  }),
]);

/** JSON にしたタスク（`POST /api/tasks` などの応答、同期メッセージの `TaskSaved`）を検証して戻す */
export const TaskJsonSchema: v.GenericSchema<unknown, Task> = v.variant("kind", [
  v.object({
    kind: v.literal("Open"),
    id: TaskIdSchema,
    title: TaskTitleSchema,
    createdAt: JsonDateSchema,
    updatedAt: JsonDateSchema,
  }),
  v.object({
    kind: v.literal("Completed"),
    id: TaskIdSchema,
    title: TaskTitleSchema,
    createdAt: JsonDateSchema,
    updatedAt: JsonDateSchema,
    completedAt: JsonDateSchema,
    completion: TaskCompletionJsonSchema,
  }),
]);

/** タスクの一覧（`GET /api/tasks`）。作った順 */
export type TaskList = Readonly<{ tasks: ReadonlyArray<Task> }>;

export const TaskListJsonSchema: v.GenericSchema<unknown, TaskList> = v.object({
  tasks: v.array(TaskJsonSchema),
});

/** 削除したタスク（`DELETE /api/tasks/:id` の応答、同期メッセージの `TaskDeleted`） */
export type DeletedTask = Readonly<{ id: TaskId }>;

export const DeletedTaskJsonSchema: v.GenericSchema<unknown, DeletedTask> = v.object({
  id: TaskIdSchema,
});

// ---------------------------------------------------------------------------
// ワークフローが使う読み書きの契約（kamae: 概念の隣に置き、1つの契約に1つの操作）
// ---------------------------------------------------------------------------

/** ID から記録されているタスクを探す */
export type FindTask = (id: TaskId) => Task | undefined;

/** タスクを記録する。同じ ID があれば書き換える */
export type SaveTask = (task: Task) => void;

/** タスクを物理削除する */
export type DeleteTask = (id: TaskId) => void;

/** すべてのタスクを、作った順に読む */
export type ListTasks = () => ReadonlyArray<Task>;
