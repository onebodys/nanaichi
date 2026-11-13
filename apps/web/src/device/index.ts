import * as v from "valibot";
import type { Backend } from "../domain/backend.ts";
import { SessionId } from "../domain/session.ts";
import { createDeviceBackend, type SyncChannel } from "./device-backend.ts";
import { createDeviceImport, type DeviceImport } from "./device-import.ts";
import type { DeviceRunDeps } from "./device-run.ts";
import { indexedDbVault } from "./vault.ts";

const LOCK = "nanaichi-device";
const CHANNEL = "nanaichi-device-sync";

const broadcastChannel = (): SyncChannel => {
  const channel = new BroadcastChannel(CHANNEL);
  return {
    post: (data) => channel.postMessage(data),
    listen: (onData) => {
      const listener = (event: MessageEvent<unknown>) => onData(event.data);
      channel.addEventListener("message", listener);
      return () => channel.removeEventListener("message", listener);
    },
  };
};

const browserRunDeps = (): DeviceRunDeps => ({
  vault: indexedDbVault(typeof indexedDB === "undefined" ? undefined : indexedDB),
  exclusive: (section) => navigator.locks.request(LOCK, section),
  // E2E は Date.now だけを差し替える（docs/E2E.md）。`new Date()` は差し替えた時刻にならない
  clock: () => new Date(Date.now()),
  persist: () => {
    // 求めても断られることがある。断られても記録は使えるので、結果は待たない
    void navigator.storage?.persist().catch(() => undefined);
  },
});

/** この端末の記録先の `Backend`。client/ はこのファイルだけを、動的 import で読み込む（ADR 0019） */
export const createBrowserDeviceBackend = (): Backend =>
  createDeviceBackend({
    ...browserRunDeps(),
    channel: broadcastChannel(),
    // `crypto.randomUUID()` は必ず UUID を返すので、検証に失敗するのは実装の誤り（例外でよい）
    newSessionId: () => v.parse(SessionId.schema, crypto.randomUUID()),
  });

/** 取り込み（ADR 0020）。ログインしている画面が、この端末の記録を読んで消すためだけに使う */
export const openBrowserDeviceImport = (): DeviceImport => createDeviceImport(browserRunDeps());

export type { DeviceImport, ImportableRecords } from "./device-import.ts";
