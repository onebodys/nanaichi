import { Result } from "@praha/byethrow";
import { describe, expect, test, vi } from "vite-plus/test";
import * as v from "valibot";
import { JournalEntryId } from "../domain/journal-entry.ts";
import { Probability, Task, TaskId, TaskTitle } from "../domain/task.ts";
import { createTaskApi } from "./task-api.ts";

const NOW = new Date(Date.UTC(2026, 9, 17, 0, 0, 0));
const id = v.parse(TaskId.schema, "00000000-0000-4000-8000-000000000001");
const title = v.parse(TaskTitle.schema, "README の更新");
const open = Task.create(id, title, NOW);

/** サーバーと同じく、本文を JSON にして返す fetch。呼ばれたパスとリクエストを記録する */
const respondWith = (status: number, body: unknown, onSignedOut = () => undefined) => {
  const paths: Array<string> = [];
  const requests: Array<RequestInit | undefined> = [];
  const fetchApi = async (path: string, init?: RequestInit) => {
    paths.push(path);
    requests.push(init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { api: createTaskApi({ fetchApi, onSignedOut }), paths, requests };
};

/** 送った本文を JSON に戻す */
const sentBody = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null");

describe("ToDo の設定", () => {
  test("GET /api/settings/tasks を呼び、設定を返す", async () => {
    const { api, paths } = respondWith(200, { kind: "Disabled" });

    const result = await api.getTaskSetting();

    expect(paths).toEqual(["/api/settings/tasks"]);
    expect(result).toEqual(Result.succeed({ kind: "Disabled" }));
  });

  test("有効にすると、PUT /api/settings/tasks に設定を送り、変えたあとの設定を返す", async () => {
    const { api, paths, requests } = respondWith(200, { kind: "Enabled" });

    const result = await api.changeTaskSetting({ kind: "Enabled" });

    expect(paths).toEqual(["/api/settings/tasks"]);
    expect(requests[0]?.method).toBe("PUT");
    expect(sentBody(requests[0])).toEqual({ kind: "Enabled" });
    expect(result).toEqual(Result.succeed({ kind: "Enabled" }));
  });

  test("応答がスキーマに合わなければ、読めない応答として Broken を返す", async () => {
    const { api } = respondWith(200, { kind: "Maybe" });

    expect(await api.getTaskSetting()).toEqual(Result.fail({ kind: "Broken" }));
  });

  test("ログインが切れていたら、失敗を返す前にログイン画面へ送る", async () => {
    const onSignedOut = vi.fn();
    const { api } = respondWith(401, { error: "UNAUTHENTICATED" }, onSignedOut);

    await api.getTaskSetting();

    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });
});

describe("タスクの取得", () => {
  test("GET /api/tasks を呼び、時刻を Date に戻したタスクの一覧を返す", async () => {
    const { api, paths } = respondWith(200, { tasks: [open] });

    const result = await api.getTasks();

    expect(paths).toEqual(["/api/tasks"]);
    expect(result).toEqual(Result.succeed({ tasks: [open] }));
  });

  test("ジャーナルからの完了のタスクは、確率ともとの記入を持って読める", async () => {
    const completed = Task.complete(
      open,
      {
        kind: "FromJournal",
        entryId: v.parse(JournalEntryId.schema, "00000000-0000-4000-8000-0000000000e1"),
        probability: v.parse(Probability.schema, 0.96),
      },
      NOW,
    );
    const { api } = respondWith(200, { tasks: [completed] });

    expect(await api.getTasks()).toEqual(Result.succeed({ tasks: [completed] }));
  });

  test("応答がスキーマに合わなければ、読めない応答として Broken を返す", async () => {
    const { api } = respondWith(200, { tasks: [{ kind: "Open" }] });

    expect(await api.getTasks()).toEqual(Result.fail({ kind: "Broken" }));
  });
});

describe("タスクの操作", () => {
  test("作るときは ID とタイトルを POST /api/tasks で送る", async () => {
    const { api, requests } = respondWith(200, open);

    const result = await api.createTask(id, title);

    expect(requests[0]?.method).toBe("POST");
    expect(sentBody(requests[0])).toEqual({ id, title });
    expect(result).toEqual(Result.succeed(open));
  });

  test("タイトルを変えるときは PATCH /api/tasks/:id でタイトルを送る", async () => {
    const { api, paths, requests } = respondWith(200, open);

    await api.renameTask(id, title);

    expect(paths).toEqual([`/api/tasks/${id}`]);
    expect(requests[0]?.method).toBe("PATCH");
    expect(sentBody(requests[0])).toEqual({ title });
  });

  test("完了にするときは POST /api/tasks/:id/complete を呼ぶ", async () => {
    const { api, paths, requests } = respondWith(200, open);

    await api.completeTask(id);

    expect(paths).toEqual([`/api/tasks/${id}/complete`]);
    expect(requests[0]?.method).toBe("POST");
  });

  test("再開するときは POST /api/tasks/:id/reopen を呼ぶ", async () => {
    const { api, paths } = respondWith(200, open);

    await api.reopenTask(id);

    expect(paths).toEqual([`/api/tasks/${id}/reopen`]);
  });

  test("削除するときは DELETE /api/tasks/:id を呼び、削除したタスクの ID を返す", async () => {
    const { api, paths, requests } = respondWith(200, { id });

    const result = await api.deleteTask(id);

    expect(paths).toEqual([`/api/tasks/${id}`]);
    expect(requests[0]?.method).toBe("DELETE");
    expect(result).toEqual(Result.succeed({ id }));
  });
});

describe("失敗", () => {
  test("ないタスクの操作は、拒否の種類つきの失敗として返す", async () => {
    const { api } = respondWith(404, { error: "TASK_NOT_FOUND" });

    expect(await api.completeTask(id)).toEqual(
      Result.fail({ kind: "Rejected", code: "TASK_NOT_FOUND" }),
    );
  });

  test("ログインが切れていたら、失敗を返す前に通知する", async () => {
    const onSignedOut = vi.fn();
    const { api } = respondWith(401, { error: "UNAUTHENTICATED" }, onSignedOut);

    await api.getTasks();

    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  test("通信できなければ、届かなかった失敗として返す", async () => {
    const api = createTaskApi({
      fetchApi: () => Promise.reject(new TypeError("offline")),
      onSignedOut: () => undefined,
    });

    expect(await api.getTasks()).toEqual(Result.fail({ kind: "Unreachable" }));
  });
});
