import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import {
  Task,
  TaskId,
  TaskTitle,
  type FindTask,
  type SaveTask,
  type TaskNotFound,
} from "../domain/task.ts";
import { loadTask } from "./task-not-found.ts";

/** `PATCH /api/tasks/:id` の本文 */
const RenameTaskInputSchema = v.object({ title: TaskTitle.schema });

export type RenameTaskError = ValidationError | TaskNotFound;

export type RenameTaskDeps = Readonly<{ findTask: FindTask; saveTask: SaveTask }>;

const parseId = schemaResult(TaskId.schema);
const parseInput = schemaResult(RenameTaskInputSchema);

/** タスクのタイトルを変える。未完了でも完了でもできる */
export const renameTask =
  (deps: RenameTaskDeps) =>
  (rawId: unknown, raw: unknown, now: Date): Result.Result<Task, RenameTaskError> =>
    Result.pipe(
      Result.do(),
      Result.bind("id", () => parseId(rawId)),
      Result.bind("input", () => parseInput(raw)),
      Result.andThen(({ id, input }) =>
        Result.pipe(
          loadTask(deps.findTask)(id),
          Result.map((task) => Task.rename(task, input.title, now)),
        ),
      ),
      Result.andThrough((task) => Result.succeed(deps.saveTask(task))),
    );
