import { Result } from "@praha/byethrow";
import type { BackendError } from "../domain/backend.ts";
import { settleAutoEnd } from "../workflows/auto-end-session.ts";
import { deviceNow, recordsDeps, type Draft } from "./records.ts";
import { VaultContent, type Vault, type VaultFailure } from "./vault.ts";

export type DeviceRunDeps = Readonly<{
  vault: Vault;
  /**
   * タブをまたいで1つずつ実行する。開いているセッションは1つという約束がタブをまたぐので、
   * UserDO が1つずつ処理するのと同じく、読み込みから書き込みまでを1つのタブだけが行う
   */
  exclusive: <T>(section: () => Promise<T>) => Promise<T>;
  clock: () => Date;
  /** 保存した記録をブラウザが消さないよう求める。最初に書いたときに1回だけ呼ぶ */
  persist: () => void;
}>;

/** 読み込んだ記録 `draft` を読み書きする1歩。`draft.current` を置き換えれば、その値を保存する */
type DeviceStep<T> = (draft: Draft, now: Date) => T;

/**
 * この端末の記録を一貫して読み書きする1サイクル: タブをまたぐロックの中で、読み込み → 自動終了の確定 →
 * `step` → 自動終了の確定 → 変わっていれば1つのトランザクションで書く。
 * `step` が例外を出したら何も書かず `Broken` を返す
 */
export type DeviceRun = <T>(step: DeviceStep<T>) => Promise<Result.Result<T, BackendError>>;

const storageFailed = (failure: VaultFailure): BackendError => {
  switch (failure.kind) {
    case "Unavailable":
    case "QuotaExceeded":
    case "NewerFormat":
      return { kind: "StorageFailed", reason: failure.kind };
    case "Broken":
      return { kind: "Broken" };
  }
};

/** alarm がないので、UserDO の `#run` と違い、`step` の前にも自動終了を確定させる */
const withAutoEndSettled =
  <T>(step: DeviceStep<T>): DeviceStep<T> =>
  (draft, now) => {
    settleAutoEnd(recordsDeps(draft))(now);
    const value = step(draft, now);
    settleAutoEnd(recordsDeps(draft))(now);
    return value;
  };

export const createDeviceRun = ({ vault, exclusive, clock, persist }: DeviceRunDeps): DeviceRun => {
  let cache: VaultContent = VaultContent.empty;
  let persistRequested = false;

  const cycle = <T>(step: DeviceStep<T>): Promise<Result.Result<T, BackendError>> =>
    exclusive(async () => {
      const loaded = await vault.load(cache);
      if (Result.isFailure(loaded)) {
        return Result.fail(storageFailed(loaded.error));
      }
      cache = loaded.value;
      const draft: Draft = { base: cache.records, current: cache.records };
      let value: T;
      try {
        value = withAutoEndSettled(step)(draft, deviceNow(clock, cache.records));
      } catch {
        return Result.fail({ kind: "Broken" } satisfies BackendError);
      }
      if (draft.current !== draft.base) {
        const committed = await vault.commit(cache, draft.current);
        if (Result.isFailure(committed)) {
          return Result.fail(storageFailed(committed.error));
        }
        cache = committed.value;
        if (!persistRequested) {
          persistRequested = true;
          persist();
        }
      }
      return Result.succeed(value);
    });

  return async (step) => {
    try {
      return await cycle(step);
    } catch {
      return Result.fail({ kind: "Broken" });
    }
  };
};
