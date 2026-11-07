import { Result } from "@praha/byethrow";
import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { JournalEntryBody } from "../domain/journal-entry.ts";
import { Task, TaskId, TaskTitle, type OpenTask } from "../domain/task.ts";
import { clefTaskJudge, type ClefAi } from "./clef-task-judge.ts";

const NOW = new Date(Date.UTC(2026, 9, 17, 0, 0, 0));

const openTask = (n: number, title = `タスク${n}`): OpenTask =>
  Task.create(
    v.parse(TaskId.schema, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
    v.parse(TaskTitle.schema, title),
    NOW,
  );
const body = (text: string) => v.parse(JournalEntryBody.schema, text);

/** ネットワークに出ない偽物の AI。呼ばれたモデルと入力を記録し、`respond` の答えを返す */
const fakeAi = (respond: () => unknown) => {
  const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  const ai: ClefAi = {
    run: async (model, input) => {
      calls.push({ model, input });
      return respond();
    },
  };
  return { ai, calls };
};

const answered = (noul: ReadonlyArray<number>, inputTokens = 100) => ({
  answers: Object.fromEntries(
    noul.map((value, index) => [`done.${index}`, { type: "noul", noul: value }]),
  ),
  usage: { input_tokens: inputTokens },
});

describe("判断モデルへの質問の組み立て", () => {
  test("clef-flash を1回だけ呼び、記入の本文と未完了のタスクの一覧を状態として渡す", async () => {
    const { ai, calls } = fakeAi(() => answered([0.1, 0.1]));

    await clefTaskJudge(ai)(body("ログイン画面のバグ修正が完了した"), [
      openTask(1, "ログイン画面のバグ修正"),
      openTask(2, "README の更新"),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("@cf/cloudflare/clef-flash");
    expect(calls[0]?.input).toMatchObject({
      model: "clef-flash",
      state: {
        journalEntry: "ログイン画面のバグ修正が完了した",
        openTasks: ["ログイン画面のバグ修正", "README の更新"],
      },
    });
  });

  test("未完了のタスクごとに「やり終えたか」の質問を1つ作り、番号つきの ID で見分ける", async () => {
    const { ai, calls } = fakeAi(() => answered([0.1, 0.1]));

    await clefTaskJudge(ai)(body("書いた"), [openTask(1, "A"), openTask(2, "B")]);

    expect(calls[0]?.input["questions"]).toMatchObject({
      "done.0": { type: "noul", instructions: { task: "A" } },
      "done.1": { type: "noul", instructions: { task: "B" } },
    });
  });

  test("長い本文は 2000 文字に切って送る", async () => {
    const { ai, calls } = fakeAi(() => answered([0.1]));

    await clefTaskJudge(ai)(body("あ".repeat(5000)), [openTask(1)]);

    expect(calls[0]?.input).toMatchObject({ state: { journalEntry: "あ".repeat(2000) } });
  });

  test("未完了のタスクが多いときは、先頭の60件だけを送る", async () => {
    const { ai, calls } = fakeAi(() => answered([]));
    const many = Array.from({ length: 70 }, (_, index) => openTask(index + 1));

    await clefTaskJudge(ai)(body("書いた"), many);

    expect(Object.keys(calls[0]?.input["questions"] ?? {})).toHaveLength(60);
  });
});

describe("判断モデルの答えの読み取り", () => {
  test("タスクごとの確率と使った入力のトークン数を、タスクの ID に結びつけて返す", async () => {
    const { ai } = fakeAi(() => answered([0.96, 0.03], 482));
    const tasks = [openTask(1), openTask(2)];

    const result = await clefTaskJudge(ai)(body("書いた"), tasks);

    expect(result).toEqual(
      Result.succeed({
        judgments: [
          { taskId: tasks[0]?.id, probability: 0.96 },
          { taskId: tasks[1]?.id, probability: 0.03 },
        ],
        inputTokens: 482,
      }),
    );
  });

  test("答えのなかった質問のタスクは、答えに含めない", async () => {
    const { ai } = fakeAi(() => answered([0.96]));
    const tasks = [openTask(1), openTask(2)];

    const result = await clefTaskJudge(ai)(body("書いた"), tasks);

    expect(result).toMatchObject({
      type: "Success",
      value: { judgments: [{ taskId: tasks[0]?.id }] },
    });
  });

  test.each([
    ["答えが空", () => ({})],
    ["使用量がない", () => ({ answers: {} })],
    ["確率が範囲の外", () => answered([1.5])],
    [
      "答えの種類が違う",
      () => ({ answers: { "done.0": { type: "yesno", yes: true } }, usage: { input_tokens: 1 } }),
    ],
  ])("%sなら、期待した形でない答えとして判断モデルが使えなかったことにする", async (_, respond) => {
    const { ai } = fakeAi(respond);

    const result = await clefTaskJudge(ai)(body("書いた"), [openTask(1)]);

    expect(result).toEqual(
      Result.fail({ kind: "DecisionUnavailable", reason: "UnexpectedResponse" }),
    );
  });

  test("呼び出しが失敗したら、判断モデルが使えなかったことにして、例外にしない", async () => {
    const ai: ClefAi = {
      run: async () => {
        throw new Error("10000 neurons per day を超えた");
      },
    };

    const result = await clefTaskJudge(ai)(body("書いた"), [openTask(1)]);

    expect(result).toEqual(Result.fail({ kind: "DecisionUnavailable", reason: "RequestFailed" }));
  });
});
