import type { Result } from "@praha/byethrow";
import type { AdvanceModeChange } from "../domain/advance-mode.ts";
import type { BackendError } from "../domain/backend.ts";
import type { ClosedSession } from "../domain/session-record.ts";
import type { SessionId } from "../domain/session.ts";
import { createDeviceRun, type DeviceRunDeps } from "./device-run.ts";
import type { DeviceRecords } from "./records.ts";

/** 取り込める記録（ADR 0020） */
export type ImportableRecords = Readonly<{
  /** 閉じたセッション。始めた時刻の順 */
  sessions: ReadonlyArray<ClosedSession>;
  /** この端末の進め方の変更履歴の全部（時刻の順） */
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>;
  /** 自動終了を確定させたあとも開いているセッションがあるか。開いているセッションは取り込まない */
  open: Readonly<{ kind: "NoOpenSession" }> | Readonly<{ kind: "OpenSessionLeft" }>;
}>;

/** ログインしている画面が、この端末の記録を読んで消すための口。この端末の記録先の `Backend` とは別に使う */
export type DeviceImport = Readonly<{
  /** 取り込める記録。自動終了の時刻を過ぎた開いているセッションは、先に閉じて記録する */
  load: () => Promise<Result.Result<ImportableRecords, BackendError>>;
  /**
   * 閉じたセッションを、1つのトランザクションでこの端末から消す。消すのは、サーバーが
   * `Imported` / `AlreadyImported` と返したものと、人が捨てると決めたものだけ。
   * ない ID と開いているセッションの ID は無視するので、やり直しても同じ結果になる
   */
  removeClosedSessions: (
    ids: ReadonlyArray<SessionId>,
  ) => Promise<Result.Result<void, BackendError>>;
}>;

const importableOf = (records: DeviceRecords): ImportableRecords => ({
  sessions: records.closed,
  advanceModeChanges: records.advanceModeChanges,
  open: { kind: records.open.kind === "Open" ? "OpenSessionLeft" : "NoOpenSession" },
});

/** 消すものがなければ同じ値を返すので、書き込みも起きない */
const withoutClosed = (records: DeviceRecords, ids: ReadonlySet<SessionId>): DeviceRecords =>
  records.closed.some(({ id }) => ids.has(id))
    ? { ...records, closed: records.closed.filter(({ id }) => !ids.has(id)) }
    : records;

/**
 * 取り込みの口。ほかのタブには同期メッセージを送らない: ログインしたあとのタブはアカウントの記録先で動き、
 * この端末の記録先で動いているタブは、次の操作で読み直す（セッションを消すと版が2つ進む、vault.ts）
 */
export const createDeviceImport = (deps: DeviceRunDeps): DeviceImport => {
  const run = createDeviceRun(deps);
  return {
    load: () => run((draft) => importableOf(draft.current)),
    removeClosedSessions: (ids) =>
      run((draft) => {
        draft.current = withoutClosed(draft.current, new Set(ids));
      }),
  };
};
