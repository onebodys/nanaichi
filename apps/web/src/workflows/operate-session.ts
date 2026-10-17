import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import {
  SessionEventId,
  SessionOperationKind,
  type RecordedSessionEvent,
  type SessionOperation,
} from "../domain/session-event.ts";
import {
  Session,
  type AppendSessionOperation,
  type FindSessionByEventId,
  type SessionSnapshot,
} from "../domain/session.ts";
import type { OperationRejected, TimerState } from "../domain/timer-state.ts";
import { loadOpenSession, type OpenSessionDeps } from "./auto-end-session.ts";
import { replayRecordedEvent, type EventIdConflict } from "./replay-recorded-event.ts";

/**
 * `POST /api/session/commands` の本文。開始の後にセッションへ行える操作を1つ送る。
 *
 * - `id`: 操作イベントの ID（クライアントが発行する）
 * - `kind`: 一時停止・再開・中断・集中の再開始・休憩スキップ・終了のどれか
 */
const OperateSessionInputSchema = v.object({
  id: SessionEventId.schema,
  kind: SessionOperationKind.schema,
});
type OperateSessionInput = v.InferOutput<typeof OperateSessionInputSchema>;

/** セッションの外では操作できない */
type NoSessionInProgress = Readonly<{ kind: "NoSessionInProgress" }>;

export type OperateSessionError =
  | ValidationError
  | NoSessionInProgress
  | OperationRejected
  | EventIdConflict;

export type OperateSessionDeps = OpenSessionDeps &
  Readonly<{
    findSessionByEventId: FindSessionByEventId;
    appendSessionOperation: AppendSessionOperation;
  }>;

const parseInput = schemaResult(OperateSessionInputSchema);

const ensureSessionInProgress = (
  open: Session | undefined,
): Result.Result<Session, NoSessionInProgress> =>
  open === undefined ? Result.fail({ kind: "NoSessionInProgress" }) : Result.succeed(open);

/** 受け付けた操作を記録する。終了したなら、セッションを閉じて現在のセッションでなくする */
const record =
  (deps: OperateSessionDeps, operation: RecordedSessionEvent<SessionOperation>) =>
  (operated: Readonly<{ session: Session; state: TimerState }>): Result.Result<void, never> => {
    deps.appendSessionOperation(operated.session.id, operation);
    if (operated.state.kind === "Ended") {
      deps.closeSession(operated.session.id, operated.state);
    }
    return Result.succeed();
  };

/**
 * セッションに操作を加える（一時停止・再開・中断・集中の再開始・休憩スキップ・終了）。
 *
 * 入力の検証 → 同じ操作が記録済みなら再送として扱う → 現在のセッションの読み込み
 * → その状態でできる操作かの判断 → 記録。時刻は呼び出し側が渡す。
 */
export const operateSession =
  (deps: OperateSessionDeps) =>
  (raw: unknown, now: Date): Result.Result<SessionSnapshot, OperateSessionError> => {
    const operate = (
      input: OperateSessionInput,
    ): Result.Result<SessionSnapshot, OperateSessionError> => {
      const operation: RecordedSessionEvent<SessionOperation> = {
        kind: input.kind,
        id: input.id,
        at: now,
      };
      return Result.pipe(
        ensureSessionInProgress(loadOpenSession(deps)(now)),
        Result.andThen((session) => Session.operate(session, operation)),
        Result.andThrough(record(deps, operation)),
        Result.map(({ session }) => Session.snapshot(session, now)),
      );
    };

    return Result.pipe(
      parseInput(raw),
      Result.andThen((input) => {
        const recorded = deps.findSessionByEventId(input.id);
        return recorded === undefined
          ? operate(input)
          : replayRecordedEvent(recorded, input.id, input.kind, now);
      }),
    );
  };
