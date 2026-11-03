import { Result } from "@praha/byethrow";
import type {
  AdvanceMode,
  AdvanceModeChange,
  LoadAdvanceModeChanges,
} from "../domain/advance-mode.ts";
import {
  Import,
  ImportBatchJsonSchema,
  type AccountRecords,
  type FindOverlappingSession,
  type LoadAccountRecords,
  type SaveImportedAdvanceModeChange,
  type SaveImportedSession,
  type SessionExists,
  type SessionImportOutcome,
} from "../domain/import.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import type { ClosedSession } from "../domain/session-record.ts";

export type ImportSessionsError = ValidationError;

export type ImportSessionsDeps = Readonly<{
  sessionExists: SessionExists;
  findOverlappingSession: FindOverlappingSession;
  loadAccountRecords: LoadAccountRecords;
  loadAdvanceModeChanges: LoadAdvanceModeChanges;
  saveImportedSession: SaveImportedSession;
  saveImportedAdvanceModeChange: SaveImportedAdvanceModeChange;
}>;

/**
 * 取り込みの結果。
 *
 * - `outcomes`: セッションごとの結果（束のセッションと同じ順）
 * - `currentMode`: アカウントのいまの進め方を端末のものにしたときだけ `Changed`（同期メッセージを決めるため）
 */
export type ImportOutcome = Readonly<{
  outcomes: ReadonlyArray<SessionImportOutcome>;
  currentMode: Readonly<{ kind: "Changed"; mode: AdvanceMode }> | Readonly<{ kind: "Unchanged" }>;
}>;

const parseBatch = schemaResult(ImportBatchJsonSchema);

/**
 * 1つのセッションを取り込む。ID がアカウントにあれば上書きせずに `AlreadyImported`、
 * 時間が重なれば `Overlapping`、それ以外は進め方の行を決めてセッションとあわせて記録する。
 * ID の確認を重なりより先にする（取り込み済みのセッションは自分自身と重なるので）
 */
const importOne =
  (deps: ImportSessionsDeps, device: ReadonlyArray<AdvanceModeChange>, account: AccountRecords) =>
  (session: ClosedSession): SessionImportOutcome => {
    if (deps.sessionExists(session.id)) {
      return { sessionId: session.id, kind: "AlreadyImported" };
    }
    if (deps.findOverlappingSession(Import.spanOf(session)) !== undefined) {
      return { sessionId: session.id, kind: "Overlapping" };
    }
    const rows = Import.advanceModeRows({
      session,
      device,
      existing: deps.loadAdvanceModeChanges(),
      account,
    });
    deps.saveImportedSession(session);
    rows.forEach(deps.saveImportedAdvanceModeChange);
    return { sessionId: session.id, kind: "Imported" };
  };

/** 取り込み以外の記録がなければ、アカウントのいまの進め方を端末のいまの進め方にする */
const adoptCurrentMode = (
  deps: ImportSessionsDeps,
  device: ReadonlyArray<AdvanceModeChange>,
  account: AccountRecords,
  now: Date,
): ImportOutcome["currentMode"] => {
  const rows = Import.currentModeRows({
    account,
    existing: deps.loadAdvanceModeChanges(),
    device,
    now,
  });
  rows.forEach(deps.saveImportedAdvanceModeChange);
  const adopted = rows.at(-1);
  return adopted === undefined ? { kind: "Unchanged" } : { kind: "Changed", mode: adopted.mode };
};

/**
 * この端末の記録を取り込む（GLOSSARY の「取り込み」、ADR 0020）。
 *
 * 入力の検証 → アカウントに取り込み以外の記録があるかの読み込み → セッションごとに判断して記録
 * → いまの進め方。前のセッションで書いたものが、後のセッションの重なりと進め方の判断に入るので、
 * セッションごとに判断と記録を交互に行う。
 * UserDO が束全体を1つの `transactionSync` で行うので、束ごとに全部書くか何も書かない
 * （ADR の「セッションごと」より強い）。ID が別のセッションのものと衝突したら例外で束全体を取り消す。
 */
export const importSessions =
  (deps: ImportSessionsDeps) =>
  (raw: unknown, now: Date): Result.Result<ImportOutcome, ImportSessionsError> =>
    Result.pipe(
      Result.do(),
      Result.bind("batch", () => parseBatch(raw)),
      Result.bind("account", () => Result.succeed(deps.loadAccountRecords())),
      Result.map(({ batch, account }) => ({
        outcomes: batch.sessions.map(importOne(deps, batch.advanceModeChanges, account)),
        currentMode: adoptCurrentMode(deps, batch.advanceModeChanges, account, now),
      })),
    );
