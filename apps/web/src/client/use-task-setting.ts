import { useCallback, useEffect, useState } from "react";
import { Result } from "@praha/byethrow";
import type { TaskSetting } from "../domain/task-setting.ts";
import type { TaskApi } from "./task-api.ts";
import { storageFailedMessageOf } from "./storage-failed-text.ts";

/**
 * ToDo の設定の読み込みの様子。
 * `Unavailable` はこの端末の記録先で、ToDo を使えない（アカウントでだけ使える、ADR 0026）
 */
export type TaskSettingView =
  | Readonly<{ kind: "Unavailable" }>
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "LoadFailed" }>
  | Readonly<{ kind: "Loaded"; setting: TaskSetting }>;

/**
 * ToDo の設定（GLOSSARY、ADR 0027）。アカウントの設定なので、サーバーに置いて読み書きする。
 *
 * - 変えたら、押した見た目がすぐ変わるよう先に手元を替え、送れなければ元に戻す
 * - 他のタブ・端末で変えたものは、同期メッセージで `receive` に届く
 */
export const useTaskSetting = (api: TaskApi | undefined) => {
  const [view, setView] = useState<TaskSettingView>(
    api === undefined ? { kind: "Unavailable" } : { kind: "Loading" },
  );
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const refresh = useCallback(() => {
    if (api === undefined) {
      return;
    }
    void api.getTaskSetting().then((result) => {
      setView((current) =>
        Result.isSuccess(result)
          ? { kind: "Loaded", setting: result.value }
          : current.kind === "Loaded"
            ? current
            : { kind: "LoadFailed" },
      );
    });
  }, [api]);

  useEffect(refresh, [refresh]);

  const change = (setting: TaskSetting) => {
    if (api === undefined) {
      return;
    }
    const before = view;
    setView({ kind: "Loaded", setting });
    setErrorMessage(undefined);
    void api.changeTaskSetting(setting).then((result) => {
      if (Result.isSuccess(result)) {
        setView({ kind: "Loaded", setting: result.value });
        return;
      }
      setView(before);
      setErrorMessage(
        result.error.kind === "StorageFailed"
          ? storageFailedMessageOf(result.error)
          : "変更できませんでした。もう一度お試しください。",
      );
    });
  };

  return {
    view,
    errorMessage,
    change,
    refresh,
    receive: (setting: TaskSetting) => setView({ kind: "Loaded", setting }),
  };
};

export type TaskSettingState = ReturnType<typeof useTaskSetting>;
