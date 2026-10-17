import { Session, type CloseSession, type FindOpenSession } from "../domain/session.ts";

export type OpenSessionDeps = Readonly<{
  findOpenSession: FindOpenSession;
  closeSession: CloseSession;
}>;

/**
 * 現在のセッションを読み込む。自動終了の時刻を過ぎていれば、ここで閉じて「セッションなし」にする。
 *
 * 自動終了は alarm で記録するが、alarm が遅れても読んだ時点で記録に残るよう、
 * セッションを読むすべてのワークフローがここを通る。
 */
export const loadOpenSession =
  (deps: OpenSessionDeps) =>
  (now: Date): Session | undefined => {
    const session = deps.findOpenSession();
    if (session === undefined) {
      return undefined;
    }
    const state = Session.stateAt(session, now);
    if (state.kind !== "Ended") {
      return session;
    }
    deps.closeSession(session.id, state);
    return undefined;
  };

/** 次に自動終了を確かめる時刻 */
export type AutoEndSchedule =
  | Readonly<{ kind: "Scheduled"; at: Date }>
  | Readonly<{ kind: "NotScheduled" }>;

/**
 * 自動終了を確定させ、次に確かめる時刻を決める（GLOSSARY の「自動終了」）。
 *
 * alarm が鳴ったときと、記入・操作を記録したあとに呼ぶ。閉じていないセッションがあれば、
 * 最後の記入・操作から2ラウンド分の位置に alarm を張り直す。
 */
export const settleAutoEnd =
  (deps: OpenSessionDeps) =>
  (now: Date): AutoEndSchedule => {
    const session = loadOpenSession(deps)(now);
    return session === undefined
      ? { kind: "NotScheduled" }
      : { kind: "Scheduled", at: Session.autoEndDueAt(session) };
  };
