import { Session, type SessionSnapshot } from "../domain/session.ts";
import { loadOpenSession, type OpenSessionDeps } from "./auto-end-session.ts";

/**
 * 現在のセッションのスナップショットを返す（`GET /api/session/current`）。
 *
 * 失敗はない。セッションがなければ（自動終了の時刻を過ぎていた場合も）`NoSession` を返す。
 */
export const getCurrentSession =
  (deps: OpenSessionDeps) =>
  (now: Date): SessionSnapshot => {
    const session = loadOpenSession(deps)(now);
    return session === undefined
      ? { kind: "NoSession", serverTime: now }
      : Session.snapshot(session, now);
  };
