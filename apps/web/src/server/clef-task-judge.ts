import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { schemaResult } from "../domain/schema-result.ts";
import type { DecisionUnavailable, JudgeCompletedTasks } from "../domain/task-decision.ts";
import { Probability, type TaskJudgment } from "../domain/task.ts";

/**
 * 判断モデル（GLOSSARY）の実装。Workers AI の clef-flash に、ジャーナル記入の本文と未完了のタスクを渡して、
 * タスクごとに「やり終えた」と言えるかを確率で答えてもらう（ADR 0026）。
 *
 * 記入1件につき呼び出しは1回。質問は未完了のタスクごとに1つ（`done.<番号>`）。
 */

const MODEL = "@cf/cloudflare/clef-flash";

/**
 * 渡すタスクの数の上限。トークンはタスク1件につき約120増え（60件で約7,400）、手元の試しでは
 * 質問が多いほど同じタスクでも確率がばらついて下がった。1回を約3,500トークンまでに抑える（ADR 0026）
 */
const OPEN_TASKS_MAX = 20;

/** 送る本文の長さの上限。長い記入でも、トークンの使用量を抑える */
const BODY_MAX_LENGTH = 2000;

/** Workers AI のバインディングのうち、使う部分。テストでは偽物に差し替える */
export type ClefAi = Readonly<{
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
}>;

const AnswerSchema = v.object({ type: v.literal("noul"), noul: Probability.schema });

const ResponseSchema = v.object({
  answers: v.record(v.string(), v.unknown()),
  usage: v.object({ input_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)) }),
});

const parseResponse = schemaResult(ResponseSchema);
const parseAnswer = schemaResult(AnswerSchema);

const questionId = (index: number): string => `done.${index}`;

const unavailable = (reason: DecisionUnavailable["reason"]): DecisionUnavailable => ({
  kind: "DecisionUnavailable",
  reason,
});

export const clefTaskJudge =
  (ai: ClefAi): JudgeCompletedTasks =>
  async (entryBody, openTasks) => {
    const tasks = openTasks.slice(0, OPEN_TASKS_MAX);
    const journalEntry = entryBody.unwrap().slice(0, BODY_MAX_LENGTH);

    const response = await Result.try({
      try: () =>
        ai.run(MODEL, {
          model: "clef-flash",
          state: { journalEntry, openTasks: tasks.map(({ title }) => title) },
          // 入力のスキーマでは、質問は「質問の ID → 質問」のオブジェクト。答えも同じ ID で返る
          questions: Object.fromEntries(
            tasks.map(({ title }, index) => [
              questionId(index),
              {
                type: "noul",
                instructions: {
                  question:
                    "このジャーナル記入は、次のタスクをやり終えたことをはっきり述べていますか？着手した・進めている・予定しているだけなら no。",
                  task: title,
                },
                criteria: {
                  true: "タスクをやり終えた",
                  false: "やり終えていない、または触れていない",
                },
              },
            ]),
          ),
        }),
      catch: () => unavailable("RequestFailed"),
    });

    return Result.pipe(
      response,
      Result.andThen((body) =>
        Result.pipe(
          parseResponse(body),
          Result.mapError(() => unavailable("UnexpectedResponse")),
        ),
      ),
      Result.andThen(({ answers, usage }) => {
        const judgments: Array<TaskJudgment> = [];
        for (const [index, task] of tasks.entries()) {
          const answer = answers[questionId(index)];
          if (answer === undefined) {
            continue;
          }
          const parsed = parseAnswer(answer);
          if (Result.isFailure(parsed)) {
            return Result.fail(unavailable("UnexpectedResponse"));
          }
          judgments.push({ taskId: task.id, probability: parsed.value.noul });
        }
        return Result.succeed({ judgments, inputTokens: usage.input_tokens });
      }),
    );
  };
