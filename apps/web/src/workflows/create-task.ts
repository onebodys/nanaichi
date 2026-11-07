import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import { Task, TaskId, TaskTitle, type FindTask, type SaveTask } from "../domain/task.ts";

/**
 * `POST /api/tasks` の本文。
 *
 * - `id`: タスクの ID（クライアントが発行する）
 * - `title`: タイトル。前後の空白を落として空なら作れない
 */
const CreateTaskInputSchema = v.object({ id: TaskId.schema, title: TaskTitle.schema });
type CreateTaskInput = v.InferOutput<typeof CreateTaskInputSchema>;

export type CreateTaskError = ValidationError;

export type CreateTaskDeps = Readonly<{ findTask: FindTask; saveTask: SaveTask }>;

const parseInput = schemaResult(CreateTaskInputSchema);

/**
 * タスクを作る（GLOSSARY の「タスク」）。
 *
 * 入力の検証 → 同じ ID のタスクが記録済みなら再送として扱う → 作って記録。
 * 通信のやり直しで同じタスクが2回届いたら、1回目に記録したものを返す。
 */
export const createTask =
  (deps: CreateTaskDeps) =>
  (raw: unknown, now: Date): Result.Result<Task, CreateTaskError> => {
    const create = ({ id, title }: CreateTaskInput): Task => {
      const recorded = deps.findTask(id);
      if (recorded !== undefined) {
        return recorded;
      }
      const task = Task.create(id, title, now);
      deps.saveTask(task);
      return task;
    };
    return Result.pipe(parseInput(raw), Result.map(create));
  };
