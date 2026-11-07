import * as v from "valibot";

/**
 * ToDo の設定（GLOSSARY の「ToDo の設定」、ADR 0027）。ToDo とジャーナルからの完了を使うかどうか。
 * アカウントごとに1つ持ち、既定は無効。
 */
export type TaskSetting = Readonly<{ kind: "Enabled" }> | Readonly<{ kind: "Disabled" }>;

const TaskSettingSchema = v.variant("kind", [
  v.object({ kind: v.literal("Enabled") }),
  v.object({ kind: v.literal("Disabled") }),
]);

export const TaskSetting = {
  /** `PUT /api/settings/tasks` の本文と、その応答の検証に使う */
  schema: TaskSettingSchema,

  default: { kind: "Disabled" } as const satisfies TaskSetting,

  equals: (a: TaskSetting, b: TaskSetting): boolean => a.kind === b.kind,
} as const;

/** JSON にした設定（`GET`・`PUT /api/settings/tasks` の応答と同期メッセージ）を検証して戻す（ADR 0009） */
export const TaskSettingJsonSchema: v.GenericSchema<unknown, TaskSetting> = TaskSettingSchema;

// ---------------------------------------------------------------------------
// ワークフローが使う読み書きの契約
// ---------------------------------------------------------------------------

/** いまの設定を読む。変えたことがなければ既定（無効） */
export type LoadTaskSetting = () => TaskSetting;

export type SaveTaskSetting = (setting: TaskSetting) => void;
