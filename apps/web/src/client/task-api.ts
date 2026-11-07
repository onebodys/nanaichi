import type { Result } from "@praha/byethrow";
import type { BackendError } from "../domain/backend.ts";
import {
  DeletedTaskJsonSchema,
  TaskJsonSchema,
  TaskListJsonSchema,
  type DeletedTask,
  type Task,
  type TaskId,
  type TaskList,
  type TaskTitle,
} from "../domain/task.ts";
import { requestApi, sendJson, type Fetch } from "./remote-backend.ts";

type Call<T> = Result.ResultAsync<T, BackendError>;

/**
 * タスクの API（ADR 0026）。タスクはアカウントの記録先でだけ使えるので、この端末の記録先（`Backend`）には載せず、
 * サーバーへの通信だけをここに置く。通信層（fetch → スキーマ検証 → Result）は `Backend` の実装と同じ。
 */
export type TaskApi = Readonly<{
  getTasks: () => Call<TaskList>;
  /** タスクを作る。`id` は画面が発行し、やり直すときは同じ ID で送れば二重に作らない */
  createTask: (id: TaskId, title: TaskTitle) => Call<Task>;
  renameTask: (id: TaskId, title: TaskTitle) => Call<Task>;
  completeTask: (id: TaskId) => Call<Task>;
  reopenTask: (id: TaskId) => Call<Task>;
  deleteTask: (id: TaskId) => Call<DeletedTask>;
}>;

export type TaskApiDeps = Readonly<{
  fetchApi?: Fetch;
  /** ログインが切れていた（`UNAUTHENTICATED`）とき、失敗を返す前に呼ぶ */
  onSignedOut: () => void;
}>;

export const createTaskApi = ({
  fetchApi = (path, init) => fetch(path, init),
  onSignedOut,
}: TaskApiDeps): TaskApi => {
  const request = requestApi(fetchApi, onSignedOut);
  return {
    getTasks: () => request("/api/tasks", TaskListJsonSchema),
    createTask: (id, title) =>
      request("/api/tasks", TaskJsonSchema, sendJson("POST", { id, title })),
    renameTask: (id, title) =>
      request(`/api/tasks/${id}`, TaskJsonSchema, sendJson("PATCH", { title })),
    completeTask: (id) => request(`/api/tasks/${id}/complete`, TaskJsonSchema, { method: "POST" }),
    reopenTask: (id) => request(`/api/tasks/${id}/reopen`, TaskJsonSchema, { method: "POST" }),
    deleteTask: (id) => request(`/api/tasks/${id}`, DeletedTaskJsonSchema, { method: "DELETE" }),
  };
};
