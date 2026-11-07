import { Result } from "@praha/byethrow";
import type { FindTask, Task, TaskId, TaskNotFound } from "../domain/task.ts";

const taskNotFound = (id: TaskId): TaskNotFound => ({ kind: "TaskNotFound", id });

/** 記録されているタスクを読む。なければ `TaskNotFound` */
export const loadTask =
  (findTask: FindTask) =>
  (id: TaskId): Result.Result<Task, TaskNotFound> => {
    const task = findTask(id);
    return task === undefined ? Result.fail(taskNotFound(id)) : Result.succeed(task);
  };
