import { Result } from "@praha/byethrow";
import type { BackendError } from "../domain/backend.ts";
import { Import, type ImportBatch, type ImportReceipt } from "../domain/import.ts";
import type { DeviceImport, ImportableRecords } from "../device/index.ts";
import type { ImportApi } from "./remote-backend.ts";

/** 取り込みを最後まで終えたときの結果 */
export type ImportResult = Readonly<{
  /** アカウントに入ったセッションの数（`Imported` と `AlreadyImported`。人にとってはどちらも入った） */
  imported: number;
  /** 時間が重なって取り込めず、この端末に残したセッションの数 */
  overlapping: number;
  open: ImportableRecords["open"];
}>;

export type ImportFailure =
  /** 通信・この端末の保存・応答の形の失敗。やり直せば、残っている分だけを送る */
  | BackendError
  /** 送りすぎ（429）が続いた */
  | Readonly<{ kind: "RateLimitedTooLong" }>;

export type ImportProgress = Readonly<{ done: number; total: number }>;

export type ImportDriverDeps = Readonly<{
  device: DeviceImport;
  send: ImportApi["sendBatch"];
  wait: (ms: number) => Promise<void>;
  onProgress: (progress: ImportProgress) => void;
}>;

/** 同じ束に 429 が続いたら諦める回数。Retry-After が 10 秒なら1分ほど */
const RATE_LIMITED_ATTEMPTS = 6;

/** 429 なら Retry-After だけ待って同じ束を送り直す。答えをもらった束は送り直さない */
const sendPatiently = async (
  deps: ImportDriverDeps,
  batch: ImportBatch,
): Promise<Result.Result<ImportReceipt, ImportFailure>> => {
  for (let attempt = 1; ; attempt += 1) {
    const sent = await deps.send(batch);
    if (Result.isSuccess(sent)) {
      return sent;
    }
    switch (sent.error.kind) {
      case "RateLimited":
        if (attempt >= RATE_LIMITED_ATTEMPTS) {
          return Result.fail({ kind: "RateLimitedTooLong" });
        }
        await deps.wait(sent.error.retryAfterMs);
        continue;
      case "Unreachable":
      case "Rejected":
      case "StorageFailed":
      case "Broken":
        return Result.fail(sent.error);
    }
  }
};

/** アカウントに入ったので、この端末から消してよいセッション */
const acceptedIdsOf = (receipt: ImportReceipt) =>
  receipt.outcomes.flatMap(({ sessionId, kind }) => {
    switch (kind) {
      case "Imported":
      case "AlreadyImported":
        return [sessionId];
      case "Overlapping":
        return [];
    }
  });

/**
 * この端末の閉じたセッションをアカウントへ取り込む（ADR 0020）。
 *
 * 1. この端末の記録を読み、束に分ける（1回の取り込みで1度だけ。答えをもらったセッションを送り直さない）
 * 2. 束を順に送り、アカウントに入ったと返ったセッションだけをこの端末から消す
 * 3. 失敗したらそこで止まる。やり直しは最初からでよい: 消した分は送らず、送ったが消せなかった分は
 *    `AlreadyImported` が返って消える
 *
 * タブをまたぐロックは、この端末の記録を読むときと消すときだけ持つ。送っている間や待っている間は、
 * ほかのタブがこの端末の記録を使える
 */
export const runImport = async (
  deps: ImportDriverDeps,
): Promise<Result.Result<ImportResult, ImportFailure>> => {
  const loaded = await deps.device.load();
  if (Result.isFailure(loaded)) {
    return loaded;
  }
  const { sessions, advanceModeChanges, open } = loaded.value;
  const total = sessions.length;
  let done = 0;
  let imported = 0;
  let overlapping = 0;
  deps.onProgress({ done, total });

  for (const batch of Import.batches(sessions, advanceModeChanges)) {
    const receipt = await sendPatiently(deps, batch);
    if (Result.isFailure(receipt)) {
      return receipt;
    }
    const accepted = acceptedIdsOf(receipt.value);
    const removed = await deps.device.removeClosedSessions(accepted);
    if (Result.isFailure(removed)) {
      return removed;
    }
    done += batch.sessions.length;
    imported += accepted.length;
    overlapping += receipt.value.outcomes.filter(({ kind }) => kind === "Overlapping").length;
    deps.onProgress({ done, total });
  }
  return Result.succeed({ imported, overlapping, open });
};
