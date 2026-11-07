import { Result } from "@praha/byethrow";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import { TaskSetting, type LoadTaskSetting, type SaveTaskSetting } from "../domain/task-setting.ts";

export type ChangeTaskSettingError = ValidationError;

export type ChangeTaskSettingDeps = Readonly<{
  loadTaskSetting: LoadTaskSetting;
  saveTaskSetting: SaveTaskSetting;
}>;

/**
 * 変えた結果。
 *
 * - `Changed`: 新しい設定を記録した
 * - `Unchanged`: いまと同じ設定だったので、何も記録していない
 */
export type TaskSettingChangeResult =
  | Readonly<{ kind: "Changed"; setting: TaskSetting }>
  | Readonly<{ kind: "Unchanged"; setting: TaskSetting }>;

const parseInput = schemaResult(TaskSetting.schema);

/** ToDo の設定を変える（`PUT /api/settings/tasks`）。入力の検証 → いまの設定の読み込み → 同じなら何もしない → 記録 */
export const changeTaskSetting =
  (deps: ChangeTaskSettingDeps) =>
  (raw: unknown): Result.Result<TaskSettingChangeResult, ChangeTaskSettingError> => {
    const change = (setting: TaskSetting): TaskSettingChangeResult => {
      const current = deps.loadTaskSetting();
      if (TaskSetting.equals(current, setting)) {
        return { kind: "Unchanged", setting: current };
      }
      deps.saveTaskSetting(setting);
      return { kind: "Changed", setting };
    };
    return Result.pipe(parseInput(raw), Result.map(change));
  };
