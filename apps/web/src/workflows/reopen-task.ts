import { Result } from "@praha/byethrow";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import { Task, TaskId, type FindTask, type SaveTask, type TaskNotFound } from "../domain/task.ts";
import { loadTask } from "./task-not-found.ts";

export type ReopenTaskError = ValidationError | TaskNotFound;

export type ReopenTaskDeps = Readonly<{ findTask: FindTask; saveTask: SaveTask }>;

const parseId = schemaResult(TaskId.schema);

/** 完了したタスクを未完了に戻す。すでに未完了なら、記録済みのタスクをそのまま返す */
export const reopenTask =
  (deps: ReopenTaskDeps) =>
  (rawId: unknown, now: Date): Result.Result<Task, ReopenTaskError> =>
    Result.pipe(
      parseId(rawId),
      Result.andThen(loadTask(deps.findTask)),
      Result.map((task): Task => {
        if (task.kind === "Open") {
          return task;
        }
        const reopened = Task.reopen(task, now);
        deps.saveTask(reopened);
        return reopened;
      }),
    );
