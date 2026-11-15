import { describe, expect, test } from "vite-plus/test";
import type { SessionSnapshot } from "../domain/session.ts";
import {
  applyLoaded,
  applyLoadFailed,
  applySynced,
  initialLoading,
  type Loading,
  startReload,
} from "./snapshot-arrival.ts";

const noSessionAt = (ms: number): SessionSnapshot => ({
  kind: "NoSession",
  serverTime: new Date(ms),
});

const offset = { serverAheadMs: 5 };

const shownTime = (loading: Loading): number | undefined => {
  switch (loading.kind) {
    case "Loading":
    case "LoadFailed":
      return undefined;
    case "Loaded":
      return loading.received.snapshot.serverTime.getTime();
  }
};

describe("読み込み中に届いた同期メッセージ", () => {
  test("読み込みの結果より新しい同期メッセージは、読み込めたときに見せる", () => {
    const synced = applySynced(initialLoading, noSessionAt(20));

    const loaded = applyLoaded(synced, { snapshot: noSessionAt(10), offset }, false);

    expect(shownTime(loaded)).toBe(20);
  });

  test("待たせた同期メッセージを見せるときの時計のずれは、読み込みで測ったもの", () => {
    const synced = applySynced(initialLoading, noSessionAt(20));

    const loaded = applyLoaded(synced, { snapshot: noSessionAt(10), offset }, false);

    expect(loaded.kind === "Loaded" && loaded.received.offset).toEqual(offset);
  });

  test("読み込みの結果より古い同期メッセージは、読み込みの結果を見せる", () => {
    const synced = applySynced(initialLoading, noSessionAt(5));

    const loaded = applyLoaded(synced, { snapshot: noSessionAt(10), offset }, false);

    expect(shownTime(loaded)).toBe(10);
  });

  test("いくつか届いたら、いちばん新しいものを待たせる", () => {
    const synced = applySynced(applySynced(initialLoading, noSessionAt(30)), noSessionAt(20));

    const loaded = applyLoaded(synced, { snapshot: noSessionAt(10), offset }, false);

    expect(shownTime(loaded)).toBe(30);
  });

  test("読み込みに失敗しても待たせたままにし、読み込み直せたときに比べる", () => {
    const failed = applyLoadFailed(applySynced(initialLoading, noSessionAt(20)));
    const synced = applySynced(failed, noSessionAt(25));

    const loaded = applyLoaded(startReload(synced), { snapshot: noSessionAt(10), offset }, false);

    expect(failed.kind).toBe("LoadFailed");
    expect(shownTime(loaded)).toBe(25);
  });

  test("読み込めたあとの同期メッセージは、待たせずにすぐ見せる", () => {
    const loaded = applyLoaded(initialLoading, { snapshot: noSessionAt(10), offset }, false);

    expect(shownTime(applySynced(loaded, noSessionAt(20)))).toBe(20);
  });
});
