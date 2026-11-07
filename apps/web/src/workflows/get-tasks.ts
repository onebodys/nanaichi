import { Result } from "@praha/byethrow";
import type { ListTasks, TaskList } from "../domain/task.ts";

export type GetTasksDeps = Readonly<{ listTasks: ListTasks }>;

/** タスクの一覧を、作った順に返す。想定内の失敗はない */
export const getTasks = (deps: GetTasksDeps) => (): Result.Result<TaskList, never> =>
  Result.succeed({ tasks: deps.listTasks() });
