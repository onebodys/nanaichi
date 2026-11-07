import type { Result } from "@praha/byethrow";
import type { JournalEntryBody, JournalEntryId } from "./journal-entry.ts";
import type { OpenTask, TaskJudgment } from "./task.ts";

/**
 * 判断モデルを呼べる回数の上限。1人あたり、UTC の1日に50回まで（ADR 0026）。
 * 判断は記入1件につき1回なので、1日に50件までの記入が判断の対象になる。
 */
export const DAILY_DECISION_LIMIT = 50;

/**
 * 判断モデルに答えてもらえなかった（ADR 0026）。
 *
 * - `NotConfigured`: AI のバインディングがない（開発サーバーとテストの既定）
 * - `RequestFailed`: 呼び出しが失敗した（Free プランの上限を超えたときを含む）
 * - `UnexpectedResponse`: 答えが期待した形でなかった
 *
 * 記入の本文は PII なので、原因の文言は持たない。
 */
export type DecisionUnavailable = Readonly<{
  kind: "DecisionUnavailable";
  reason: "NotConfigured" | "RequestFailed" | "UnexpectedResponse";
}>;

/** 判断モデルの答え。`inputTokens` は使った入力のトークン数で、記録して利用量を見る */
export type TaskJudgments = Readonly<{
  judgments: ReadonlyArray<TaskJudgment>;
  inputTokens: number;
}>;

/**
 * 記入の本文を読み、未完了のタスクそれぞれが「やり終えた」と言えるかを確率で答える（GLOSSARY の「判断モデル」）。
 * 非同期で外部に出ていくので、ワークフローの外（UserDO）が呼ぶ。
 */
export type JudgeCompletedTasks = (
  entryBody: JournalEntryBody,
  openTasks: ReadonlyArray<OpenTask>,
) => Promise<Result.Result<TaskJudgments, DecisionUnavailable>>;

/** 判断の回数を数える1日の始まり（UTC の 0:00） */
export const decisionDayStartOf = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * 判断の記録（監査の証跡）。記入1件につき1行で、判断を始めたときに `Pending` で作り、終えたら書き換える。
 * `Pending` のまま残っていれば、判断の途中で止まっている。
 */
export type DecisionOutcome = "Pending" | "Judged" | "Unavailable";

/** 記入 `entryId` の判断を始めたと記録する。上限の数え方に入る */
export type StartDecisionRun = (entryId: JournalEntryId, startedAt: Date) => void;

/** 判断を終えたと記録する */
export type FinishDecisionRun = (
  entryId: JournalEntryId,
  outcome: Exclude<DecisionOutcome, "Pending">,
  inputTokens: number,
) => void;

/** 記入 `entryId` の判断をすでに始めているか */
export type HasDecisionRun = (entryId: JournalEntryId) => boolean;

/** `since` 以降に始めた判断の数 */
export type CountDecisionRunsSince = (since: Date) => number;

/** 判断モデルの答えを残す。しきい値に届かなかった惜しいものを、あとから見直せるようにする */
export type SaveTaskJudgments = (
  entryId: JournalEntryId,
  judgments: ReadonlyArray<TaskJudgment>,
) => void;
