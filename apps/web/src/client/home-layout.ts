import type { TaskSettingView } from "./use-task-setting.ts";

/**
 * ホーム画面の左ペインの配置（ADR 0027）。
 * ToDo を使うときだけ `WithTasks`: タイマーを簡略にして上に、ToDo を下に置く。それ以外は従来のまま（`Standard`）
 */
export type HomeLayout = Readonly<{ kind: "Standard" }> | Readonly<{ kind: "WithTasks" }>;

export const homeLayoutOf = (setting: TaskSettingView): HomeLayout => {
  switch (setting.kind) {
    case "Loaded":
      return setting.setting.kind === "Enabled" ? { kind: "WithTasks" } : { kind: "Standard" };
    case "Unavailable":
    case "Loading":
    case "LoadFailed":
      return { kind: "Standard" };
  }
};
