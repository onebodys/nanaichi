import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import { SessionEventId } from "../domain/session-event.ts";
import {
  Session,
  type FindSessionByEventId,
  type SaveStartedSession,
  type SessionId,
  type SessionSnapshot,
} from "../domain/session.ts";
import { loadOpenSession, type OpenSessionDeps } from "./auto-end-session.ts";
import { replayRecordedEvent, type EventIdConflict } from "./replay-recorded-event.ts";

/** `POST /api/session` の本文。`id` は開始の操作イベントの ID（クライアントが発行する） */
const StartSessionInputSchema = v.object({ id: SessionEventId.schema });
type StartSessionInput = v.InferOutput<typeof StartSessionInputSchema>;

/** 同時に持てるセッションは1つまで */
type SessionAlreadyInProgress = Readonly<{
  kind: "SessionAlreadyInProgress";
  sessionId: SessionId;
}>;

export type StartSessionError = ValidationError | SessionAlreadyInProgress | EventIdConflict;

export type StartSessionDeps = OpenSessionDeps &
  Readonly<{
    findSessionByEventId: FindSessionByEventId;
    saveStartedSession: SaveStartedSession;
  }>;

const parseInput = schemaResult(StartSessionInputSchema);

const ensureNoSessionInProgress = (
  open: Session | undefined,
): Result.Result<void, SessionAlreadyInProgress> =>
  open === undefined
    ? Result.succeed()
    : Result.fail({ kind: "SessionAlreadyInProgress", sessionId: open.id });

/**
 * セッションを開始する（GLOSSARY の「開始」）。
 *
 * 入力の検証 → 同じ開始が記録済みなら再送として扱う → 現在のセッションがないことの確認
 * → 開始 → 記録。自動終了の時刻を過ぎたセッションは、確認の前に閉じる（`loadOpenSession`）。
 *
 * 時刻と新しいセッションの ID は呼び出し側が渡す（ドメインとワークフローは時計と乱数を読まない）。
 */
export const startSession =
  (deps: StartSessionDeps) =>
  (
    raw: unknown,
    now: Date,
    newSessionId: SessionId,
  ): Result.Result<SessionSnapshot, StartSessionError> => {
    const start = (input: StartSessionInput): Result.Result<SessionSnapshot, StartSessionError> =>
      Result.pipe(
        ensureNoSessionInProgress(loadOpenSession(deps)(now)),
        Result.map(() => Session.start(newSessionId, input.id, now)),
        Result.andThrough((session) => Result.succeed(deps.saveStartedSession(session))),
        Result.map((session) => Session.snapshot(session, now)),
      );

    return Result.pipe(
      parseInput(raw),
      Result.andThen((input) => {
        const recorded = deps.findSessionByEventId(input.id);
        return recorded === undefined
          ? start(input)
          : replayRecordedEvent(recorded, input.id, "Start", now);
      }),
    );
  };
