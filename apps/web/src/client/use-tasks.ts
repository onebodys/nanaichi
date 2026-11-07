import { useCallback, useEffect, useState } from "react";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import type { BackendError } from "../domain/backend.ts";
import { TaskId, TaskTitle, type DeletedTask, type Task } from "../domain/task.ts";
import { removeTask, upsertTask } from "./task-list.ts";
import type { TaskApi } from "./task-api.ts";

// `crypto.randomUUID()` は必ず UUID を返すので、検証に失敗するのは実装の誤り（例外でよい）
const newTaskId = (): TaskId => v.parse(TaskId.schema, crypto.randomUUID());

/**
 * タスクの一覧の読み込みの様子。
 * `Unavailable` はこの端末の記録先で、タスクを使えない（アカウントでだけ使える、ADR 0026）
 */
export type TasksView =
  | Readonly<{ kind: "Unavailable" }>
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "LoadFailed" }>
  | Readonly<{ kind: "Loaded"; tasks: ReadonlyArray<Task> }>;

/** 画面に出す失敗の文言。サーバーの文言はそのまま出さない */
const messageOf = (error: BackendError): string => {
  switch (error.kind) {
    case "Unreachable":
      return "通信できませんでした。もう一度お試しください。";
    case "Rejected":
      return error.code === "TASK_NOT_FOUND"
        ? "そのタスクはもうありません。一覧を読み込み直しました。"
        : "操作できませんでした。";
    case "StorageFailed":
    case "Broken":
      return "操作できませんでした。";
  }
};

/**
 * ToDo のパネルのタスク（GLOSSARY の「タスク」、ADR 0026）。
 *
 * - 繋がるたびに読み込み直し、切れていた間の変更を取り込む（`refresh`）
 * - 自分の操作の応答と、他のタブ・端末や自動完了の同期メッセージ（`receiveSaved` / `receiveDeleted`）を同じ一覧に反映する
 * - 操作が通ったかを `true` / `false` で返す。失敗の文言は `errorMessage` に出る
 */
export const useTasks = (api: TaskApi | undefined) => {
  const [view, setView] = useState<TasksView>(
    api === undefined ? { kind: "Unavailable" } : { kind: "Loading" },
  );
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const refresh = useCallback(() => {
    if (api === undefined) {
      return;
    }
    void api.getTasks().then((result) => {
      setView((current) =>
        Result.isSuccess(result)
          ? { kind: "Loaded", tasks: result.value.tasks }
          : current.kind === "Loaded"
            ? current
            : { kind: "LoadFailed" },
      );
    });
  }, [api]);

  useEffect(refresh, [refresh]);

  const receiveSaved = useCallback((task: Task) => {
    setView((current) =>
      current.kind === "Loaded"
        ? { kind: "Loaded", tasks: upsertTask(current.tasks, task) }
        : current,
    );
  }, []);

  const receiveDeleted = useCallback((deleted: DeletedTask) => {
    setView((current) =>
      current.kind === "Loaded"
        ? { kind: "Loaded", tasks: removeTask(current.tasks, deleted.id) }
        : current,
    );
  }, []);

  /** 操作を呼び、通れば `onDone` で一覧に反映する。失敗したら文言を出し、一覧を読み込み直す */
  const operate = async <T>(
    call: (api: TaskApi) => Result.ResultAsync<T, BackendError>,
    onDone: (value: T) => void,
  ): Promise<boolean> => {
    if (api === undefined) {
      return false;
    }
    const result = await call(api);
    if (Result.isFailure(result)) {
      setErrorMessage(messageOf(result.error));
      refresh();
      return false;
    }
    setErrorMessage(undefined);
    onDone(result.value);
    return true;
  };

  return {
    view,
    errorMessage,
    refresh,
    receiveSaved,
    receiveDeleted,
    /** 空のタイトルは作らない（`false`） */
    create: (title: string): Promise<boolean> => {
      const parsed = v.safeParse(TaskTitle.schema, title);
      return parsed.success
        ? operate((a) => a.createTask(newTaskId(), parsed.output), receiveSaved)
        : Promise.resolve(false);
    },
    rename: (id: TaskId, title: string): Promise<boolean> => {
      const parsed = v.safeParse(TaskTitle.schema, title);
      return parsed.success
        ? operate((a) => a.renameTask(id, parsed.output), receiveSaved)
        : Promise.resolve(false);
    },
    complete: (id: TaskId): Promise<boolean> => operate((a) => a.completeTask(id), receiveSaved),
    reopen: (id: TaskId): Promise<boolean> => operate((a) => a.reopenTask(id), receiveSaved),
    remove: (id: TaskId): Promise<boolean> => operate((a) => a.deleteTask(id), receiveDeleted),
  };
};

export type TasksState = ReturnType<typeof useTasks>;
