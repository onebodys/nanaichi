import type { BackendError } from "../domain/backend.ts";
import { Import, type ImportSummary } from "../domain/import.ts";
import { localDateIn } from "../domain/local-date.ts";
import type { ClosedSession } from "../domain/session-record.ts";
import { TAG_KINDS_MAX } from "../domain/tag.ts";
import type { ImportFailure, ImportResult } from "./import-driver.ts";
import { dateLabelOf } from "./journal-text.ts";
import { storageFailedMessageOf } from "./storage-failed-text.ts";
import { sessionSpanLabelOf } from "./timer-text.ts";
import type { LastImport } from "./use-import.ts";

/** 取り込み（ADR 0020）の文言。判断はせず、取り込みの様子を言葉にするだけ（AGENTS.md §5） */

/** この端末に残っている記録の数（`3セッション・記入 12件`） */
export const deviceRecordsLabelOf = ({ sessions, entries }: ImportSummary): string =>
  `${sessions}セッション・記入 ${entries}件`;

/** この端末に残っているセッションの見出し（`11月2日（月） 09:00 〜 09:30`）。日付は始めた日 */
export const deviceSessionLabelOf = (session: ClosedSession, timeZone: string): string => {
  const { startedAt, endedAt } = Import.spanOf(session);
  return `${dateLabelOf(localDateIn(timeZone)(startedAt))} ${sessionSpanLabelOf(startedAt, endedAt)}`;
};

export const importProgressLabelOf = (done: number, total: number): string =>
  `取り込んでいます… ${done} / ${total} セッション`;

/** 取り込みを終えたときに出す文。重なったもの・開いたままのもの・タグの上限は、あるときだけ */
export const importResultLinesOf = (
  result: ImportResult,
  tagKindsOverLimit: boolean,
): ReadonlyArray<string> => [
  `${result.imported}セッションをアカウントに取り込みました。`,
  ...(result.overlapping === 0
    ? []
    : [
        `${result.overlapping}セッションは、アカウントの記録と時間が重なるため取り込めませんでした。設定画面の「アカウント」で中身を確かめて、捨てられます。`,
      ]),
  ...openSessionLinesOf(result.open),
  ...(tagKindsOverLimit
    ? [
        `使っているタグが ${TAG_KINDS_MAX} 種類を超えました。新しいタグをつけるには、設定画面の「タグ」で使わないタグを削除してください。`,
      ]
    : []),
];

export const openSessionLinesOf = (open: ImportResult["open"]): ReadonlyArray<string> => {
  switch (open.kind) {
    case "NoOpenSession":
      return [];
    case "OpenSessionLeft":
      return ["この端末で開いたままのセッションは、終えてから取り込めます。"];
  }
};

const backendFailureMessageOf = (error: BackendError): string => {
  switch (error.kind) {
    case "Unreachable":
      return "通信できませんでした。";
    case "StorageFailed":
      return storageFailedMessageOf(error);
    case "Rejected":
    case "Broken":
      return "取り込めませんでした。";
  }
};

/** 設定画面に出す、最後に取り込んだときの結果と、この端末で開いたままのセッション */
export const lastImportLinesOf = (
  last: LastImport,
  open: ImportResult["open"],
): ReadonlyArray<string> => {
  switch (last.kind) {
    case "NotRun":
      return openSessionLinesOf(open);
    case "Finished":
      return importResultLinesOf(last.result, last.tagKindsOverLimit);
    case "Failed":
      return [importFailureMessageOf(last.failure), ...openSessionLinesOf(open)];
  }
};

/** 途中で止まったときの文言。取り込めた分はこの端末から消えているので、やり直すと残りだけを送る */
export const importFailureMessageOf = (failure: ImportFailure): string => {
  switch (failure.kind) {
    case "RateLimitedTooLong":
      return "混み合っているため取り込めませんでした。しばらくしてからやり直してください。取り込めた分はそのままです。";
    case "Unreachable":
    case "StorageFailed":
    case "Rejected":
    case "Broken":
      return `${backendFailureMessageOf(failure)}やり直すと、残りの記録だけを取り込みます。`;
  }
};

/** この端末の記録を読めなかったとき */
export const deviceUnreadableMessageOf = (error: BackendError): string => {
  switch (error.kind) {
    case "StorageFailed":
      return storageFailedMessageOf(error);
    case "Unreachable":
    case "Rejected":
    case "Broken":
      return "この端末の記録を読めませんでした。";
  }
};
