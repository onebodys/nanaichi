import { Result } from "@praha/byethrow";
import type { JournalEntry, JournalEntryBody, JournalEntryId } from "../domain/journal-entry.ts";
import {
  DAILY_DECISION_LIMIT,
  decisionDayStartOf,
  type CountDecisionRunsSince,
  type DecisionUnavailable,
  type FinishDecisionRun,
  type HasDecisionRun,
  type SaveTaskJudgments,
  type StartDecisionRun,
  type TaskJudgments,
} from "../domain/task-decision.ts";
import {
  Task,
  type CompletedTask,
  type ListTasks,
  type OpenTask,
  type SaveTask,
} from "../domain/task.ts";

/**
 * ジャーナルからの完了（GLOSSARY）を、判断モデルを呼ぶ前と後の2つの同期的なワークフローに分ける。
 * 判断モデルの呼び出しは非同期で、UserDO の書き込みのトランザクションに入れられないため、
 * 呼び出しは間にある UserDO（Imperative Shell）が行う。
 *
 * 1. `prepareCompletionFromJournal`: 判断するか決める → 判断を始めたと記録する
 * 2. （UserDO が判断モデルを呼ぶ）
 * 3. `finishCompletionFromJournal`: 答えから完了にするタスクを決めて記録する
 */

/** 判断しない理由。どれも想定内で、記入には影響しない */
export type NotDecided =
  /** 未完了のタスクがない。判断モデルを呼ばない */
  | Readonly<{ kind: "NoOpenTasks" }>
  /** この記入はすでに判断を始めている（記入の再送や、判断の途中で止まった記入） */
  | Readonly<{ kind: "AlreadyDecided"; entryId: JournalEntryId }>
  /** 今日の判断の回数が上限に達した（ADR 0026） */
  | Readonly<{ kind: "DailyLimitReached" }>;

/** 判断モデルに渡すもの */
export type PreparedDecision = Readonly<{
  entryId: JournalEntryId;
  body: JournalEntryBody;
  openTasks: ReadonlyArray<OpenTask>;
}>;

export type PrepareCompletionDeps = Readonly<{
  listTasks: ListTasks;
  hasDecisionRun: HasDecisionRun;
  countDecisionRunsSince: CountDecisionRunsSince;
  startDecisionRun: StartDecisionRun;
}>;

const ensureNotDecided =
  (deps: PrepareCompletionDeps) =>
  (entryId: JournalEntryId): Result.Result<void, NotDecided> =>
    deps.hasDecisionRun(entryId)
      ? Result.fail({ kind: "AlreadyDecided", entryId })
      : Result.succeed();

const loadOpenTasks =
  (deps: PrepareCompletionDeps) => (): Result.Result<ReadonlyArray<OpenTask>, NotDecided> => {
    const open = deps.listTasks().flatMap((task) => (task.kind === "Open" ? [task] : []));
    // 新しく作ったタスクほど、記入で完了にしたいものであることが多いので先に並べる
    // （判断モデルに渡す数に上限があり、あふれたものは判断しない）
    return open.length === 0
      ? Result.fail({ kind: "NoOpenTasks" })
      : Result.succeed(open.toReversed());
  };

const ensureWithinDailyLimit =
  (deps: PrepareCompletionDeps, now: Date) => (): Result.Result<void, NotDecided> =>
    deps.countDecisionRunsSince(decisionDayStartOf(now)) >= DAILY_DECISION_LIMIT
      ? Result.fail({ kind: "DailyLimitReached" })
      : Result.succeed();

/**
 * 記入を書いたあと、判断モデルに渡すものを用意する。
 *
 * すでに判断した記入でないことの確認 → 未完了のタスクの読み込み（なければ判断しない）
 * → 今日の判断の回数が上限を超えないことの確認 → 判断を始めたと記録。
 */
export const prepareCompletionFromJournal =
  (deps: PrepareCompletionDeps) =>
  (entry: JournalEntry, now: Date): Result.Result<PreparedDecision, NotDecided> =>
    Result.pipe(
      Result.do(),
      Result.andThrough(() => ensureNotDecided(deps)(entry.id)),
      Result.bind("openTasks", loadOpenTasks(deps)),
      Result.andThrough(ensureWithinDailyLimit(deps, now)),
      Result.andThrough(() => Result.succeed(deps.startDecisionRun(entry.id, now))),
      Result.map(({ openTasks }) => ({ entryId: entry.id, body: entry.body, openTasks })),
    );

export type FinishCompletionDeps = Readonly<{
  listTasks: ListTasks;
  saveTask: SaveTask;
  saveTaskJudgments: SaveTaskJudgments;
  finishDecisionRun: FinishDecisionRun;
}>;

/**
 * 判断モデルの答えから、完了にするタスクを決めて記録する。完了にしたタスクを返す。
 *
 * 答えを待っている間にタスクが変わりうるので、未完了のタスクを読み直してから決める
 * （その間に完了にされた・削除されたタスクは触らない）。判断モデルが使えなかったときは、
 * 何も変えずに、使えなかったと記録するだけ。
 */
export const finishCompletionFromJournal =
  (deps: FinishCompletionDeps) =>
  (
    entryId: JournalEntryId,
    decision: Result.Result<TaskJudgments, DecisionUnavailable>,
    now: Date,
  ): ReadonlyArray<CompletedTask> => {
    if (Result.isFailure(decision)) {
      deps.finishDecisionRun(entryId, "Unavailable", 0);
      return [];
    }
    const { judgments, inputTokens } = decision.value;
    const completed = Task.completedByJournal(deps.listTasks(), judgments, entryId, now);
    completed.forEach(deps.saveTask);
    deps.saveTaskJudgments(entryId, judgments);
    deps.finishDecisionRun(entryId, "Judged", inputTokens);
    return completed;
  };
