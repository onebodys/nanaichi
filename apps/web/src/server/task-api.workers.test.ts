import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { schemaResult } from "../domain/schema-result.ts";
import { SyncMessageJsonSchema } from "../domain/sync-message.ts";
import {
  DAILY_DECISION_LIMIT,
  type DecisionUnavailable,
  type JudgeCompletedTasks,
} from "../domain/task-decision.ts";
import {
  DeletedTaskJsonSchema,
  Probability,
  TaskJsonSchema,
  TaskListJsonSchema,
} from "../domain/task.ts";
import { prepareDatabase, request, resetStorage, signInAs } from "./workers-test-harness.ts";

// 時計の扱いは journal-api.workers.test.ts と同じ。alarm がすぐ鳴らないよう、本当の時計より先の時刻でテストする
const STARTED_AT = Date.UTC(2100, 0, 1, 12, 0, 0);
const DAY_MS = 24 * 60 * 60_000;
const ORIGIN = "http://localhost:5173";

let headers: Headers;
let userId: string;
const opened: Array<WebSocket> = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(STARTED_AT);
  await prepareDatabase();
  ({ headers, userId } = await signInAs("me@example.com"));
});

afterEach(async () => {
  for (const ws of opened.splice(0)) {
    ws.close();
  }
  vi.useRealTimers();
  await resetStorage();
});

const cookie = () => headers.get("cookie") ?? "";
const withBody = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { cookie: cookie(), "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const createTask = (title: unknown, id: string = crypto.randomUUID()) =>
  request("/api/tasks", withBody("POST", { id, title }));
const renameTask = (id: string, title: unknown) =>
  request(`/api/tasks/${id}`, withBody("PATCH", { title }));
const completeTask = (id: string) => request(`/api/tasks/${id}/complete`, withBody("POST"));
const reopenTask = (id: string) => request(`/api/tasks/${id}/reopen`, withBody("POST"));
const deleteTask = (id: string) => request(`/api/tasks/${id}`, withBody("DELETE"));
const listTasks = () => request("/api/tasks", { headers });
const parseTask = (json: unknown) => v.parse(TaskJsonSchema, json);

const startSession = () => request("/api/session", withBody("POST", { id: crypto.randomUUID() }));
const writeEntry = (body: string, id: string = crypto.randomUUID()) =>
  request("/api/journal-entries", withBody("POST", { id, body }));

/** 作ったタスクの ID を返す */
const newTask = async (title: string): Promise<string> => {
  const res = await createTask(title);
  return parseTask(await res.json()).id;
};

const tasksNow = async () => v.parse(TaskListJsonSchema, await (await listTasks()).json()).tasks;

/** 同期の WebSocket を開き、届いた文字列を順にためる */
const connect = async () => {
  const res = await request("/api/ws", {
    headers: { cookie: cookie(), upgrade: "websocket", origin: ORIGIN },
  });
  const ws = res.webSocket;
  if (ws === null) {
    throw new Error("WebSocket が返ってこなかった");
  }
  ws.accept();
  opened.push(ws);
  const received: Array<string> = [];
  ws.addEventListener("message", (event) => {
    received.push(typeof event.data === "string" ? event.data : "(binary)");
  });
  return received;
};
const decode = (data: string | undefined) =>
  schemaResult(SyncMessageJsonSchema)(JSON.parse(data ?? "null"));

const probability = (value: number) => v.parse(Probability.schema, value);

/** 判断モデルを偽物に差し替える。どのタスクにも `answer` の確率を答え、呼ばれた引数を記録する */
const replaceJudge = async (answer: (title: string) => number) => {
  const calls: Array<{ body: string; titles: Array<string> }> = [];
  const judge: JudgeCompletedTasks = async (body, openTasks) => {
    calls.push({ body: body.unwrap(), titles: openTasks.map(({ title }) => title) });
    return Result.succeed({
      judgments: openTasks.map(({ id, title }) => ({
        taskId: id,
        probability: probability(answer(title)),
      })),
      inputTokens: 321,
    });
  };
  await replaceJudgeWith(judge);
  return calls;
};

const replaceJudgeWith = (judge: JudgeCompletedTasks) =>
  runInDurableObject(env.USER_DO.getByName(userId), (instance) => instance.replaceTaskJudge(judge));

const sqlOf = <T>(read: (sql: SqlStorage) => T) =>
  runInDurableObject(env.USER_DO.getByName(userId), (_, state) => read(state.storage.sql));

/** 判断を始めた記録が今日の分だけ `count` 件あることにする */
const fillDecisionRuns = (count: number, decidedAt: number) =>
  sqlOf((sql) => {
    for (let i = 0; i < count; i += 1) {
      sql.exec(
        "INSERT INTO task_decision_runs (entry_id, decided_at, outcome) VALUES (?, ?, 'Judged')",
        crypto.randomUUID(),
        decidedAt,
      );
    }
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("ログインしていないとき", () => {
  test.each([
    ["GET", "/api/tasks"],
    ["POST", "/api/tasks"],
    ["PATCH", `/api/tasks/${crypto.randomUUID()}`],
    ["POST", `/api/tasks/${crypto.randomUUID()}/complete`],
    ["POST", `/api/tasks/${crypto.randomUUID()}/reopen`],
    ["DELETE", `/api/tasks/${crypto.randomUUID()}`],
  ])("%s %s は 401 を返す", async (method, path) => {
    const res = await request(path, { method });

    expect(res.status).toBe(401);
  });
});

describe("タスクを作る・読む", () => {
  test("作ったタスクは未完了で、一覧に作った順で出る", async () => {
    const first = await createTask("  README の更新  ");
    await createTask("ログイン画面のバグ修正");

    expect(first.status).toBe(200);
    expect(parseTask(await first.json())).toMatchObject({
      kind: "Open",
      title: "README の更新",
      createdAt: new Date(STARTED_AT),
    });
    expect((await tasksNow()).map(({ title }) => title)).toEqual([
      "README の更新",
      "ログイン画面のバグ修正",
    ]);
  });

  test("同じ ID で2回作っても1件だけ記録される", async () => {
    const id = crypto.randomUUID();

    await createTask("README の更新", id);
    const again = await createTask("README の更新", id);

    expect(again.status).toBe(200);
    expect(await tasksNow()).toHaveLength(1);
  });

  test.each([
    ["タイトルが空", { id: crypto.randomUUID(), title: "  " }],
    ["ID が UUID でない", { id: "x", title: "README の更新" }],
  ])("%sなら 400 を返し、作らない", async (_, body) => {
    const res = await request("/api/tasks", withBody("POST", body));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVALID_REQUEST" });
    expect(await tasksNow()).toEqual([]);
  });
});

describe("タスクを変える", () => {
  test("タイトルを変えられる", async () => {
    const id = await newTask("READEME の更新");

    const res = await renameTask(id, "README の更新");

    expect(parseTask(await res.json())).toMatchObject({ id, title: "README の更新" });
    expect((await tasksNow()).map(({ title }) => title)).toEqual(["README の更新"]);
  });

  test("自分で完了にすると手動の完了になり、再開すると未完了に戻る", async () => {
    const id = await newTask("README の更新");
    vi.setSystemTime(STARTED_AT + 60_000);

    const completed = parseTask(await (await completeTask(id)).json());
    const reopened = parseTask(await (await reopenTask(id)).json());

    expect(completed).toMatchObject({
      kind: "Completed",
      completedAt: new Date(STARTED_AT + 60_000),
      completion: { kind: "Manual" },
    });
    expect(reopened).toMatchObject({ kind: "Open", id });
    expect(reopened).not.toHaveProperty("completion");
  });

  test("完了にしたタスクをもう一度完了にしても、最初に完了にした時刻のまま", async () => {
    const id = await newTask("README の更新");
    await completeTask(id);
    vi.setSystemTime(STARTED_AT + 60_000);

    const again = parseTask(await (await completeTask(id)).json());

    expect(again).toMatchObject({ kind: "Completed", completedAt: new Date(STARTED_AT) });
  });

  test("削除したタスクは一覧から消える", async () => {
    const id = await newTask("README の更新");

    const res = await deleteTask(id);

    expect(v.parse(DeletedTaskJsonSchema, await res.json())).toEqual({ id });
    expect(await tasksNow()).toEqual([]);
  });

  test.each([
    ["タイトルを変える", (id: string) => renameTask(id, "x")],
    ["完了にする", completeTask],
    ["再開する", reopenTask],
    ["削除する", deleteTask],
  ])("ないタスクを%sと 404 を返す", async (_, operate) => {
    const res = await operate(crypto.randomUUID());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "TASK_NOT_FOUND" });
  });

  test("タスクの操作は、開いている画面へ同期メッセージで届く", async () => {
    const received = await connect();
    const id = await newTask("README の更新");
    await completeTask(id);
    await deleteTask(id);

    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received.map((data) => decode(data))).toMatchObject([
      { type: "Success", value: { kind: "TaskSaved", task: { kind: "Open", id } } },
      { type: "Success", value: { kind: "TaskSaved", task: { kind: "Completed", id } } },
      { type: "Success", value: { kind: "TaskDeleted", deleted: { id } } },
    ]);
  });
});

describe("ジャーナルからの完了", () => {
  beforeEach(async () => {
    await startSession();
  });

  test("確率が 0.95 の判断なら、タスクが完了になり、完了にした記入と確率が残り、画面へ知らせる", async () => {
    const id = await newTask("ログイン画面のバグ修正");
    const calls = await replaceJudge(() => 0.95);
    const received = await connect();
    const entryId = crypto.randomUUID();

    await writeEntry("ログイン画面のバグ修正が完了した、次は README の更新に取り掛かる", entryId);

    await vi.waitFor(async () => expect((await tasksNow())[0]?.kind).toBe("Completed"));
    expect((await tasksNow())[0]).toMatchObject({
      id,
      completion: { kind: "FromJournal", entryId, probability: 0.95 },
    });
    expect(calls).toEqual([
      {
        body: "ログイン画面のバグ修正が完了した、次は README の更新に取り掛かる",
        titles: ["ログイン画面のバグ修正"],
      },
    ]);
    await vi.waitFor(() =>
      expect(
        received
          .map((data) => decode(data))
          .filter(
            (message) =>
              Result.isSuccess(message) &&
              message.value.kind === "TaskSaved" &&
              message.value.task.kind === "Completed",
          ),
      ).toHaveLength(1),
    );
  });

  test("確率が 0.9 ちょうどの判断でも完了になる", async () => {
    await newTask("ログイン画面のバグ修正");
    await replaceJudge(() => 0.9);

    await writeEntry("ログイン画面のバグ修正が完了した");

    await vi.waitFor(async () => expect((await tasksNow())[0]?.kind).toBe("Completed"));
  });

  test("確率が 0.89 の判断なら、タスクは未完了のまま。答えは惜しいものとして残る", async () => {
    await newTask("ログイン画面のバグ修正");
    const calls = await replaceJudge(() => 0.89);
    const entryId = crypto.randomUUID();

    await writeEntry("ログイン画面のバグ修正をほぼ終えた", entryId);

    await vi.waitFor(async () =>
      expect(
        await sqlOf((sql) => sql.exec("SELECT outcome FROM task_decision_runs").toArray()),
      ).toEqual([{ outcome: "Judged" }]),
    );
    expect(calls).toHaveLength(1);
    expect((await tasksNow())[0]?.kind).toBe("Open");
    expect(
      await sqlOf((sql) => sql.exec("SELECT entry_id, probability FROM task_judgments").toArray()),
    ).toEqual([{ entry_id: entryId, probability: 0.89 }]);
  });

  test("判断では使ったトークンの数も記録に残る", async () => {
    await newTask("ログイン画面のバグ修正");
    await replaceJudge(() => 0.1);

    await writeEntry("調べている");

    await vi.waitFor(async () =>
      expect(
        await sqlOf((sql) => sql.exec("SELECT input_tokens FROM task_decision_runs").toArray()),
      ).toEqual([{ input_tokens: 321 }]),
    );
  });

  test("確率の高いタスクだけが完了になり、ほかのタスクは未完了のまま", async () => {
    await newTask("ログイン画面のバグ修正");
    await newTask("README の更新");
    await replaceJudge((title) => (title.includes("ログイン") ? 0.96 : 0.03));

    await writeEntry("ログイン画面のバグ修正が完了した");

    await vi.waitFor(async () =>
      expect((await tasksNow()).map(({ title, kind }) => [title, kind])).toEqual([
        ["ログイン画面のバグ修正", "Completed"],
        ["README の更新", "Open"],
      ]),
    );
  });

  test("未完了のタスクがなければ、判断モデルを呼ばず、判断の記録も残さない", async () => {
    const id = await newTask("ログイン画面のバグ修正");
    await completeTask(id);
    const calls = await replaceJudge(() => 0.99);

    const res = await writeEntry("何かをやり終えた");
    await settle();

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    expect(await sqlOf((sql) => sql.exec("SELECT * FROM task_decision_runs").toArray())).toEqual(
      [],
    );
  });

  test("今日の判断の回数が上限に達していたら、判断モデルを呼ばずに記入だけを書く", async () => {
    await newTask("ログイン画面のバグ修正");
    const calls = await replaceJudge(() => 0.99);
    await fillDecisionRuns(DAILY_DECISION_LIMIT, STARTED_AT - 60_000);

    const res = await writeEntry("ログイン画面のバグ修正が完了した");
    await settle();

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    expect((await tasksNow())[0]?.kind).toBe("Open");
  });

  test("上限に1回足りなければ、判断モデルを呼ぶ", async () => {
    await newTask("ログイン画面のバグ修正");
    const calls = await replaceJudge(() => 0.99);
    await fillDecisionRuns(DAILY_DECISION_LIMIT - 1, STARTED_AT - 60_000);

    await writeEntry("ログイン画面のバグ修正が完了した");

    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  test("前の日の判断は今日の回数に数えない", async () => {
    await newTask("ログイン画面のバグ修正");
    const calls = await replaceJudge(() => 0.99);
    // 12:00 の前日の同時刻。UTC の日付が変わる前の分は、今日の回数に入らない
    await fillDecisionRuns(DAILY_DECISION_LIMIT, STARTED_AT - DAY_MS);

    await writeEntry("ログイン画面のバグ修正が完了した");

    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  test("同じ記入を再送しても、判断モデルを呼ぶのは1回だけ", async () => {
    await newTask("ログイン画面のバグ修正");
    const calls = await replaceJudge(() => 0.5);
    const entryId = crypto.randomUUID();

    await writeEntry("ログイン画面のバグ修正が完了した", entryId);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await writeEntry("ログイン画面のバグ修正が完了した", entryId);
    await settle();

    expect(calls).toHaveLength(1);
  });

  test("判断モデルが使えなくても記入は書け、タスクは未完了のまま。使えなかったことが記録に残る", async () => {
    await newTask("ログイン画面のバグ修正");
    const unavailable: DecisionUnavailable = {
      kind: "DecisionUnavailable",
      reason: "RequestFailed",
    };
    await replaceJudgeWith(async () => Result.fail(unavailable));

    const res = await writeEntry("ログイン画面のバグ修正が完了した");

    expect(res.status).toBe(200);
    await vi.waitFor(async () =>
      expect(
        await sqlOf((sql) => sql.exec("SELECT outcome FROM task_decision_runs").toArray()),
      ).toEqual([{ outcome: "Unavailable" }]),
    );
    expect((await tasksNow())[0]?.kind).toBe("Open");
  });

  test("判断を待っている間に自分で完了にしたタスクは、そのまま手動の完了として残る", async () => {
    const id = await newTask("ログイン画面のバグ修正");
    let resolveRelease: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    await replaceJudgeWith(async (_, openTasks) => {
      await released;
      return Result.succeed({
        judgments: openTasks.map((task) => ({ taskId: task.id, probability: probability(0.99) })),
        inputTokens: 1,
      });
    });

    await writeEntry("ログイン画面のバグ修正が完了した");
    await completeTask(id);
    resolveRelease();

    await vi.waitFor(async () =>
      expect(
        await sqlOf((sql) => sql.exec("SELECT outcome FROM task_decision_runs").toArray()),
      ).toEqual([{ outcome: "Judged" }]),
    );
    expect((await tasksNow())[0]).toMatchObject({
      kind: "Completed",
      completion: { kind: "Manual" },
    });
  });

  test("本物の Workers AI につながっていないテストでは、判断モデルは使えず、記入だけが書ける", async () => {
    await newTask("ログイン画面のバグ修正");

    const res = await writeEntry("ログイン画面のバグ修正が完了した");

    expect(res.status).toBe(200);
    await vi.waitFor(async () =>
      expect(
        await sqlOf((sql) => sql.exec("SELECT outcome FROM task_decision_runs").toArray()),
      ).toEqual([{ outcome: "Unavailable" }]),
    );
    expect((await tasksNow())[0]?.kind).toBe("Open");
  });
});
