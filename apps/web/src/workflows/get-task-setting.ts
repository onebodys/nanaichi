import { Result } from "@praha/byethrow";
import type { LoadTaskSetting, TaskSetting } from "../domain/task-setting.ts";

export type GetTaskSettingDeps = Readonly<{ loadTaskSetting: LoadTaskSetting }>;

/** いまの ToDo の設定を返す（`GET /api/settings/tasks`）。想定内の失敗はない */
export const getTaskSetting = (deps: GetTaskSettingDeps) => (): Result.Result<TaskSetting, never> =>
  Result.succeed(deps.loadTaskSetting());
