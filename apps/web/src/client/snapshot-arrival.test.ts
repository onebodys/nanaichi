import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { Revision, type SessionSnapshot } from "../domain/session.ts";
import { applyReceived, applySynced, type Loading, type Received } from "./snapshot-arrival.ts";

const snapshotAt = (revision: number, serverMs: number): SessionSnapshot => ({
  kind: "NoSession",
  serverTime: new Date(serverMs),
  revision: v.parse(Revision.schema, revision),
});

const received = (revision: number, serverMs: number): Received => ({
  snapshot: snapshotAt(revision, serverMs),
  offset: { serverAheadMs: 0 },
});

const shownRevision = (loading: Loading) =>
  loading.kind === "Loaded" ? loading.received.snapshot.revision : undefined;

describe("届いたスナップショットの反映", () => {
  test("自分の操作の応答を待つ間に届いた読み込みが別の端末の変更まで含んでいれば見せ、あとから届いた操作の応答は古いので捨てる", () => {
    // 画面 A が開始（変更の番号 1）を送り、その間に別の端末の一時停止（2）が処理された。
    // A はまだ同期メッセージを受け取れていない
    const beforeStart: Loading = { kind: "Loaded", received: received(0, 1) };

    const afterLoad = applyReceived(beforeStart, received(2, 30));
    const afterStartResponse = applyReceived(afterLoad, received(1, 10));

    expect(shownRevision(afterLoad)).toBe(2);
    expect(shownRevision(afterStartResponse)).toBe(2);
  });

  test("自分の操作より前に処理された読み込みが操作の応答のあとに届いても、変更の番号が古いので捨てる", () => {
    const afterStartResponse: Loading = { kind: "Loaded", received: received(1, 10) };

    const afterLoad = applyReceived(afterStartResponse, received(0, 10));

    expect(shownRevision(afterLoad)).toBe(1);
  });

  test("まだ読み込めていない画面は、届いた読み込みをそのまま見せる", () => {
    expect(shownRevision(applyReceived({ kind: "Loading" }, received(3, 5)))).toBe(3);
    expect(shownRevision(applyReceived({ kind: "LoadFailed" }, received(3, 5)))).toBe(3);
  });

  test("読み込めていない間に届いた同期メッセージは捨て、読み込みの結果を待つ", () => {
    expect(applySynced({ kind: "Loading" }, snapshotAt(1, 10))).toEqual({ kind: "Loading" });
  });
});
