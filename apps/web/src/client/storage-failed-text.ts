import type { BackendError } from "../domain/backend.ts";

type StorageFailure = Extract<BackendError, { kind: "StorageFailed" }>;

/** この端末に保存できなかったときの文言（ADR 0019）。ログインすれば記録を残せるので、そこへ案内する */
export const storageFailedMessageOf = ({ reason }: StorageFailure): string => {
  switch (reason) {
    case "QuotaExceeded":
      return "この端末に保存できる量を超えました。ログインすると記録を残し続けられます。";
    case "Unavailable":
      return "この端末に記録を保存できませんでした。ブラウザの設定で保存が禁止されていないか確認してください。";
    case "NewerFormat":
      return "この端末の記録は、新しい版のアプリで保存されたものなので開けません。ページを読み込み直してください。";
  }
};
