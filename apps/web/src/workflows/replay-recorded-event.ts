import { Result } from "@praha/byethrow";
import type { SessionEventId, SessionOperation } from "../domain/session-event.ts";
import { Session, type SessionSnapshot } from "../domain/session.ts";

/** 記録済みの操作イベントと同じ ID で、別の操作が届いた（クライアントの ID の発行の誤り） */
export type EventIdConflict = Readonly<{ kind: "EventIdConflict"; eventId: SessionEventId }>;

/**
 * 同じ ID の操作イベントがすでに記録されていれば、記録し直さずに、そのセッションの今の様子を返す。
 *
 * 通信のやり直しで同じ操作が2回届いても、1回目と同じ成功として扱う（ADR 0007）。
 * 1回目のあとにセッションが閉じていても、そのセッションの今の様子（終了）を返す。
 */
export const replayRecordedEvent = (
  session: Session,
  eventId: SessionEventId,
  kind: "Start" | SessionOperation["kind"],
  now: Date,
): Result.Result<SessionSnapshot, EventIdConflict> => {
  const recorded = session.events.find((event) => event.id === eventId);
  return recorded?.kind === kind
    ? Result.succeed(Session.snapshot(session, now))
    : Result.fail({ kind: "EventIdConflict", eventId });
};
