import { Session, type CurrentRevision, type SessionSnapshot } from "../domain/session.ts";
import { loadOpenSession, type OpenSessionDeps } from "./auto-end-session.ts";

/** スナップショットを作るワークフローが使う契約。変更の番号は、記録を書いたあとに読む（ADR 0030） */
export type SnapshotDeps = OpenSessionDeps & Readonly<{ currentRevision: CurrentRevision }>;

/**
 * 現在のセッションのスナップショットを返す（`GET /api/session/current`）。
 *
 * 失敗はない。セッションがなければ（自動終了の時刻を過ぎていた場合も）`NoSession` を返す。
 */
export const getCurrentSession =
  (deps: SnapshotDeps) =>
  (now: Date): SessionSnapshot => {
    const session = loadOpenSession(deps)(now);
    return session === undefined
      ? { kind: "NoSession", serverTime: now, revision: deps.currentRevision() }
      : Session.snapshot(session, now, deps.currentRevision());
  };
