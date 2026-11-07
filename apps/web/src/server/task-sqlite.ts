import * as v from "valibot";
import { JournalEntryId } from "../domain/journal-entry.ts";
import type {
  CountDecisionRunsSince,
  FinishDecisionRun,
  HasDecisionRun,
  SaveTaskJudgments,
  StartDecisionRun,
} from "../domain/task-decision.ts";
import {
  Probability,
  TaskId,
  TaskTitle,
  type DeleteTask,
  type FindTask,
  type ListTasks,
  type SaveTask,
  type Task,
  type TaskCompletion,
} from "../domain/task.ts";
import { epochMs, parseRow } from "./session-sqlite.ts";

// ---------------------------------------------------------------------------
// DB の行（境界）。読み出した行はスキーマで検証し、その場でドメインの型に変換する
// ---------------------------------------------------------------------------

const TaskRowSchema = v.pipe(
  v.object({
    id: TaskId.schema,
    title: TaskTitle.schema,
    created_at: epochMs,
    updated_at: epochMs,
    completed_at: v.nullable(epochMs),
    completion_kind: v.nullable(v.picklist(["Manual", "FromJournal"])),
    completion_entry_id: v.nullable(JournalEntryId.schema),
    completion_probability: v.nullable(Probability.schema),
  }),
  v.rawTransform(({ dataset, addIssue, NEVER }): Task => {
    const row = dataset.value;
    const base = {
      id: row.id,
      title: row.title,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
    if (row.completed_at === null) {
      return { kind: "Open", ...base };
    }
    const completion = completionOf(row);
    if (completion === undefined) {
      addIssue({ message: "完了の列の組み合わせが不正", path: undefined });
      return NEVER;
    }
    return { kind: "Completed", ...base, completedAt: new Date(row.completed_at), completion };
  }),
);

/** 完了の列を、完了のしかたの型に戻す。CHECK 制約で守っているので、合わないのは記録が壊れているとき */
const completionOf = (
  row: Readonly<{
    completion_kind: "Manual" | "FromJournal" | null;
    completion_entry_id: JournalEntryId | null;
    completion_probability: Probability | null;
  }>,
): TaskCompletion | undefined => {
  switch (row.completion_kind) {
    case "Manual":
      return { kind: "Manual" };
    case "FromJournal":
      return row.completion_entry_id === null || row.completion_probability === null
        ? undefined
        : {
            kind: "FromJournal",
            entryId: row.completion_entry_id,
            probability: row.completion_probability,
          };
    case null:
      return undefined;
  }
};

const parseTaskRow = parseRow(TaskRowSchema, "tasks");

const CountRowSchema = v.object({ count: v.pipe(v.number(), v.integer(), v.minValue(0)) });
const parseCountRow = parseRow(CountRowSchema, "task_decision_runs");

/** 完了のしかたを列に書く形にする */
const columnsOf = (completion: TaskCompletion) => {
  switch (completion.kind) {
    case "Manual":
      return { kind: completion.kind, entryId: null, probability: null };
    case "FromJournal":
      return {
        kind: completion.kind,
        entryId: completion.entryId,
        probability: completion.probability,
      };
  }
};

// ---------------------------------------------------------------------------
// 読み書きの契約（domain/task.ts, domain/task-decision.ts）を DO の SQLite で実装する
// ---------------------------------------------------------------------------

export type TaskSqlite = Readonly<{
  findTask: FindTask;
  saveTask: SaveTask;
  deleteTask: DeleteTask;
  listTasks: ListTasks;
  hasDecisionRun: HasDecisionRun;
  countDecisionRunsSince: CountDecisionRunsSince;
  startDecisionRun: StartDecisionRun;
  finishDecisionRun: FinishDecisionRun;
  saveTaskJudgments: SaveTaskJudgments;
}>;

export const taskSqlite = (sql: SqlStorage): TaskSqlite => ({
  findTask: (id) => {
    const [row] = sql.exec("SELECT * FROM tasks WHERE id = ?", id).toArray();
    return row === undefined ? undefined : parseTaskRow(row);
  },

  saveTask: (task) => {
    const completed = task.kind === "Completed" ? task : undefined;
    const completion = completed === undefined ? undefined : columnsOf(completed.completion);
    sql.exec(
      `INSERT INTO tasks
         (id, title, created_at, updated_at, completed_at,
          completion_kind, completion_entry_id, completion_probability)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         completed_at = excluded.completed_at,
         completion_kind = excluded.completion_kind,
         completion_entry_id = excluded.completion_entry_id,
         completion_probability = excluded.completion_probability`,
      task.id,
      task.title,
      task.createdAt.getTime(),
      task.updatedAt.getTime(),
      completed === undefined ? null : completed.completedAt.getTime(),
      completion?.kind ?? null,
      completion?.entryId ?? null,
      completion?.probability ?? null,
    );
  },

  deleteTask: (id) => {
    sql.exec("DELETE FROM tasks WHERE id = ?", id);
  },

  listTasks: () =>
    sql.exec("SELECT * FROM tasks ORDER BY created_at, rowid").toArray().map(parseTaskRow),

  hasDecisionRun: (entryId) =>
    sql.exec("SELECT 1 FROM task_decision_runs WHERE entry_id = ?", entryId).toArray().length > 0,

  countDecisionRunsSince: (since) =>
    parseCountRow(
      sql
        .exec(
          "SELECT COUNT(*) AS count FROM task_decision_runs WHERE decided_at >= ?",
          since.getTime(),
        )
        .one(),
    ).count,

  startDecisionRun: (entryId, startedAt) => {
    sql.exec(
      "INSERT INTO task_decision_runs (entry_id, decided_at, outcome) VALUES (?, ?, 'Pending')",
      entryId,
      startedAt.getTime(),
    );
  },

  finishDecisionRun: (entryId, outcome, inputTokens) => {
    sql.exec(
      "UPDATE task_decision_runs SET outcome = ?, input_tokens = ? WHERE entry_id = ?",
      outcome,
      inputTokens,
      entryId,
    );
  },

  saveTaskJudgments: (entryId, judgments) => {
    for (const { taskId, probability } of judgments) {
      sql.exec(
        `INSERT INTO task_judgments (entry_id, task_id, probability) VALUES (?, ?, ?)
         ON CONFLICT (entry_id, task_id) DO UPDATE SET probability = excluded.probability`,
        entryId,
        taskId,
        probability,
      );
    }
  },
});
