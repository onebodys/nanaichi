import { Result } from "@praha/byethrow";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import {
  TaskId,
  type DeleteTask,
  type DeletedTask,
  type FindTask,
  type TaskNotFound,
} from "../domain/task.ts";
import { loadTask } from "./task-not-found.ts";

export type DeleteTaskError = ValidationError | TaskNotFound;

export type DeleteTaskDeps = Readonly<{ findTask: FindTask; deleteTask: DeleteTask }>;

const parseId = schemaResult(TaskId.schema);

/** タスクを削除する（物理削除、GLOSSARY の「タスク」）。記録がなければ `TaskNotFound` */
export const deleteTask =
  (deps: DeleteTaskDeps) =>
  (rawId: unknown): Result.Result<DeletedTask, DeleteTaskError> =>
    Result.pipe(
      parseId(rawId),
      Result.andThen(loadTask(deps.findTask)),
      Result.map(({ id }): DeletedTask => {
        deps.deleteTask(id);
        return { id };
      }),
    );
