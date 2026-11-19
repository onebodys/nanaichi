import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { Revision, type SessionSnapshot } from "../domain/session.ts";
import {
  applyLoadFailed,
  applyReceived,
  applySynced,
  initialLoading,
  type Loading,
  startReload,
} from "./snapshot-arrival.ts";

/** 時刻が後のものほど、あとの変更のスナップショット（変更の番号も大きい） */
const noSessionAt = (ms: number): SessionSnapshot => ({
  kind: "NoSession",
  serverTime: new Date(ms),
  revision: v.parse(Revision.schema, ms),
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

    const loaded = applyReceived(synced, { snapshot: noSessionAt(10), offset });

    expect(shownTime(loaded)).toBe(20);
  });

  test("待たせた同期メッセージを見せるときの時計のずれは、読み込みで測ったもの", () => {
    const synced = applySynced(initialLoading, noSessionAt(20));

    const loaded = applyReceived(synced, { snapshot: noSessionAt(10), offset });

    expect(loaded.kind === "Loaded" && loaded.received.offset).toEqual(offset);
  });

  test("読み込みの結果より古い同期メッセージは、読み込みの結果を見せる", () => {
    const synced = applySynced(initialLoading, noSessionAt(5));

    const loaded = applyReceived(synced, { snapshot: noSessionAt(10), offset });

    expect(shownTime(loaded)).toBe(10);
  });

  test("いくつか届いたら、いちばん新しいものを待たせる", () => {
    const synced = applySynced(applySynced(initialLoading, noSessionAt(30)), noSessionAt(20));

    const loaded = applyReceived(synced, { snapshot: noSessionAt(10), offset });

    expect(shownTime(loaded)).toBe(30);
  });

  test("読み込みに失敗しても待たせたままにし、読み込み直せたときに比べる", () => {
    const failed = applyLoadFailed(applySynced(initialLoading, noSessionAt(20)));
    const synced = applySynced(failed, noSessionAt(25));

    const loaded = applyReceived(startReload(synced), { snapshot: noSessionAt(10), offset });

    expect(failed.kind).toBe("LoadFailed");
    expect(shownTime(loaded)).toBe(25);
  });

  test("読み込めたあとの同期メッセージは、待たせずにすぐ見せる", () => {
    const loaded = applyReceived(initialLoading, { snapshot: noSessionAt(10), offset });

    expect(shownTime(applySynced(loaded, noSessionAt(20)))).toBe(20);
  });
});

describe("自分の操作と重なった読み込み", () => {
  test("操作の応答を待つ間に届いた読み込みが別の端末の変更まで含んでいれば見せ、あとから届いた操作の応答は古いので捨てる", () => {
    // 画面が開始（変更の番号 1）を送り、その間に別の端末の一時停止（2）が処理された。
    // 画面はまだ同期メッセージを受け取れていない
    const beforeStart = applyReceived(initialLoading, { snapshot: noSessionAt(0), offset });

    const afterLoad = applyReceived(beforeStart, { snapshot: noSessionAt(2), offset });
    const afterStartResponse = applyReceived(afterLoad, { snapshot: noSessionAt(1), offset });

    expect(shownTime(afterLoad)).toBe(2);
    expect(shownTime(afterStartResponse)).toBe(2);
  });

  test("操作より前に処理された読み込みが操作の応答のあとに届いても、変更の番号が古いので捨てる", () => {
    const afterStartResponse = applyReceived(initialLoading, { snapshot: noSessionAt(1), offset });

    const afterLoad = applyReceived(afterStartResponse, { snapshot: noSessionAt(0), offset });

    expect(shownTime(afterLoad)).toBe(1);
  });
});
