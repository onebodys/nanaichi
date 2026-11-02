import { Result } from "@praha/byethrow";
import { createContext, createElement, useContext, type ReactNode } from "react";
import { authClient } from "./auth-client.ts";

/**
 * いまの記録先（GLOSSARY の「記録先」、ADR 0019）。ログインしていなければこの端末、していればアカウント。
 */
export type RecordStore =
  | Readonly<{ kind: "Device" }>
  | Readonly<{ kind: "Account"; user: Readonly<{ name: string }> }>;

/** ログインしているかを確かめられなかった（通信の失敗やサーバーの障害）。この端末の記録先にはしない */
export type RecordStoreUnknown = Readonly<{ kind: "RecordStoreUnknown" }>;

/**
 * ログインの状態から記録先を決める。確かめられないときにこの端末へ倒すと、
 * ログイン中の人の記録がこの端末とアカウントに分かれてしまうので、失敗として返す
 */
export const resolveRecordStore = (): Result.ResultAsync<RecordStore, RecordStoreUnknown> =>
  Result.pipe(
    Result.try({
      try: () => authClient.getSession(),
      catch: (): RecordStoreUnknown => ({ kind: "RecordStoreUnknown" }),
    }),
    Result.andThen(({ data, error }): Result.Result<RecordStore, RecordStoreUnknown> => {
      if (error !== null) {
        return Result.fail({ kind: "RecordStoreUnknown" });
      }
      return Result.succeed(
        data === null ? { kind: "Device" } : { kind: "Account", user: { name: data.user.name } },
      );
    }),
  );

const RecordStoreContext = createContext<RecordStore | undefined>(undefined);

export const RecordStoreProvider = ({
  recordStore,
  children,
}: Readonly<{ recordStore: RecordStore; children: ReactNode }>): ReactNode =>
  createElement(RecordStoreContext.Provider, { value: recordStore }, children);

export const useRecordStore = (): RecordStore => {
  const recordStore = useContext(RecordStoreContext);
  if (recordStore === undefined) {
    throw new Error("useRecordStore は RecordStoreProvider の中で使う");
  }
  return recordStore;
};
