import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import { createOperationTracker, type OperationTracker } from "../client/operation-overlap.ts";
import {
  applyLoaded,
  applyReceived,
  applySynced,
  type Loading,
} from "../client/snapshot-arrival.ts";
import { schemaResult } from "../domain/schema-result.ts";
import { type SessionSnapshot, SessionSnapshotJsonSchema } from "../domain/session.ts";
import { SyncMessage } from "../domain/sync-message.ts";
import {
  eventually,
  prepareDatabase,
  request,
  resetStorage,
  signInAs,
} from "../server/workers-test-harness.ts";

/**
 * 同期のモデル（formal/session-sync/SessionSync.tla）と実装が一致しているかを確かめるためのトレースを取る。
 *
 * 本物の UserDO（HTTP と同期の WebSocket）に、2つの画面として要求を送る。画面の側は、届いた
 * スナップショットの反映（client/snapshot-arrival.ts）と操作との重なり（client/operation-overlap.ts）
 * を本物で動かす。React の配線（`use-session-timer.ts` が、いつ何を呼ぶか）はここで写している。
 *
 * どの応答・メッセージをいつ画面に渡すかはテストが決める。1手ごとにモデルのアクションの名前と、
 * そのときの値（UserDO が出したスナップショット、画面が見せているもの）を記録し、`task.meta` に残す。
 * `node formal/session-sync/check.mjs --trace` が JSON の報告から取り出して TLC に通す。
 *
 * server と client の両方を使うので、どちらにも属さない testing/ に置く。
 */

const STARTED_AT = Date.UTC(2100, 0, 1, 0, 0, 0);
const at = (ms: number) => vi.setSystemTime(STARTED_AT + ms);

const ORIGIN = "http://localhost:5173";
let cookie: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  await prepareDatabase();
  const { headers } = await signInAs("me@example.com");
  cookie = headers.get("cookie") ?? "";
});

afterEach(async () => {
  vi.useRealTimers();
  await resetStorage();
});

type ScreenName = "s1" | "s2";

/** モデルの1手。使わない欄は空文字か 0 */
type Step = Readonly<{
  action: string;
  screen: ScreenName;
  result: string;
  cause: string;
  /** UserDO が出したスナップショットのサーバーの時刻（ミリ秒）と、何番目の変更までを含むか */
  ms: number;
  v: number;
  /** 手のあとに画面が見せているもの */
  loading: string;
  shownMs: number;
  shownV: number;
}>;

/**
 * スナップショットが何番目の変更までを含むか（モデルの `v`）。このテストでは開始と操作しか送らず、
 * 終了もしないので、記録された操作イベントの数がそのまま変更の数になる
 */
const versionOf = (snapshot: SessionSnapshot): number => {
  switch (snapshot.kind) {
    case "NoSession":
      return 0;
    case "Session":
      return snapshot.session.events.length;
  }
};

const parseSnapshot = (body: unknown): SessionSnapshot =>
  Result.unwrap(schemaResult(SessionSnapshotJsonSchema)(body));

type LoadRequest = Readonly<{
  token: ReturnType<OperationTracker["readStarted"]>;
  cause: "Refresh";
}>;
type LoadResponse = Readonly<{ request: LoadRequest; snapshot: SessionSnapshot }>;
type OpResponse =
  | Readonly<{ kind: "Ok"; snapshot: SessionSnapshot }>
  | Readonly<{ kind: "Rejected" }>;

type Screen = {
  readonly name: ScreenName;
  loading: Loading;
  readonly tracker: OperationTracker;
  /** WebSocket に届いて、まだ画面に渡していないメッセージ */
  readonly inbox: Array<string>;
  socket: WebSocket | undefined;
};

/** トレースを記録しながら、画面と UserDO を1手ずつ動かす */
const recorder = () => {
  const steps: Array<Step> = [];
  const record = (step: Partial<Step> & Pick<Step, "action" | "screen">, screen?: Screen) => {
    const shown = screen?.loading.kind === "Loaded" ? screen.loading.received.snapshot : undefined;
    steps.push({
      result: "",
      cause: "",
      ms: 0,
      v: 0,
      loading: screen?.loading.kind ?? "",
      shownMs: shown?.serverTime.getTime() ?? 0,
      shownV: shown === undefined ? 0 : versionOf(shown),
      ...step,
    });
  };

  /** 画面を開く。モデルの初期状態と同じく、読み込みを1つ送り、同期の WebSocket を開き始める */
  const mount = (name: ScreenName): [Screen, LoadRequest] => {
    const tracker = createOperationTracker();
    const screen: Screen = {
      name,
      loading: { kind: "Loading" },
      tracker,
      inbox: [],
      socket: undefined,
    };
    return [screen, { token: tracker.readStarted(), cause: "Refresh" }];
  };

  const serveLoad = async (screen: Screen, req: LoadRequest): Promise<LoadResponse> => {
    const res = await request("/api/session/current", { headers: { cookie } });
    expect(res.status).toBe(200);
    const snapshot = parseSnapshot(await res.json());
    record({
      action: "ServeLoad",
      screen: screen.name,
      cause: req.cause,
      ms: snapshot.serverTime.getTime(),
      v: versionOf(snapshot),
    });
    return { request: req, snapshot };
  };

  /** use-session-timer.ts の load の後半 */
  const receiveLoad = (screen: Screen, res: LoadResponse) => {
    const overlapped = screen.tracker.overlapped(res.request.token);
    screen.loading = applyLoaded(
      screen.loading,
      { snapshot: res.snapshot, offset: { serverAheadMs: 0 } },
      overlapped,
    );
    record({ action: "ReceiveLoad", screen: screen.name, cause: res.request.cause }, screen);
  };

  /** use-session-timer.ts の send の前半（operations.begin） */
  const operate = (screen: Screen) => {
    screen.tracker.begin();
    record({ action: "Operate", screen: screen.name }, screen);
  };

  const serveOp = async (screen: Screen, body: object): Promise<OpResponse> => {
    const path = "kind" in body ? "/api/session/commands" : "/api/session";
    const res = await request(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), ...body }),
    });
    if (!res.ok) {
      record({ action: "ServeOp", screen: screen.name, result: "Rejected" });
      return { kind: "Rejected" };
    }
    const snapshot = parseSnapshot(await res.json());
    record({
      action: "ServeOp",
      screen: screen.name,
      result: "Ok",
      ms: snapshot.serverTime.getTime(),
      v: versionOf(snapshot),
    });
    return { kind: "Ok", snapshot };
  };

  /** use-session-timer.ts の send の後半（operations.end のあと反映） */
  const receiveOp = (screen: Screen, res: OpResponse) => {
    screen.tracker.end();
    if (res.kind === "Ok") {
      screen.loading = applyReceived(screen.loading, {
        snapshot: res.snapshot,
        offset: { serverAheadMs: 0 },
      });
    }
    record({ action: "ReceiveOp", screen: screen.name, result: res.kind }, screen);
  };

  /** `GET /api/ws`。UserDO が受け入れたら、これより後の同期メッセージがこの接続に届く */
  const accept = async (screen: Screen) => {
    const res = await request("/api/ws", {
      headers: { cookie, upgrade: "websocket", origin: ORIGIN },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (ws === null) {
      throw new Error("WebSocket が返ってこなかった");
    }
    ws.accept();
    ws.addEventListener("message", (event) => {
      if (screen.socket === ws && typeof event.data === "string") {
        screen.inbox.push(event.data);
      }
    });
    screen.socket = ws;
    record({ action: "Accept", screen: screen.name });
  };

  /** sync-connection.ts の onOpen → use-sync.ts の onConnected → timer.refresh() */
  const opened = (screen: Screen): LoadRequest => {
    const req: LoadRequest = { token: screen.tracker.readStarted(), cause: "Refresh" };
    record({ action: "Opened", screen: screen.name });
    return req;
  };

  /** use-sync.ts の deliver → timer.receive */
  const receiveSync = async (screen: Screen) => {
    await eventually(() => expect(screen.inbox.length).toBeGreaterThan(0));
    const message = SyncMessage.deserialize(screen.inbox.shift());
    if (message?.kind !== "SessionChanged") {
      throw new Error(`SessionChanged ではないメッセージが届いた: ${message?.kind ?? "読めない"}`);
    }
    screen.loading = applySynced(screen.loading, message.snapshot);
    record({ action: "ReceiveSync", screen: screen.name }, screen);
  };

  /** WebSocket が切れる。届いていないメッセージは捨てる */
  const disconnect = (screen: Screen) => {
    screen.socket?.close();
    screen.socket = undefined;
    screen.inbox.splice(0);
    record({ action: "Disconnect", screen: screen.name });
  };

  const reconnect = (screen: Screen) => record({ action: "Reconnect", screen: screen.name });

  return {
    steps,
    mount,
    serveLoad,
    receiveLoad,
    operate,
    serveOp,
    receiveOp,
    accept,
    opened,
    receiveSync,
    disconnect,
    reconnect,
  };
};

const shownVersion = (screen: Screen) =>
  screen.loading.kind === "Loaded" ? versionOf(screen.loading.received.snapshot) : undefined;

describe("同期のトレース（formal/session-sync で TLC に通す）", () => {
  test("2つの画面で開始と一時停止が HTTP と同期メッセージの両方で届き、切れた画面は繋ぎ直して追いつく", async ({
    task,
  }) => {
    const r = recorder();
    const [s1, s1Mount] = r.mount("s1");
    const [s2, s2Mount] = r.mount("s2");
    await r.accept(s1);
    await r.accept(s2);
    const s1Refresh = r.opened(s1);
    const s2Refresh = r.opened(s2);
    at(1);
    const s1MountRes = await r.serveLoad(s1, s1Mount);
    at(2);
    const s2MountRes = await r.serveLoad(s2, s2Mount);
    r.receiveLoad(s1, s1MountRes);
    r.receiveLoad(s2, s2MountRes);
    at(3);
    const s1RefreshRes = await r.serveLoad(s1, s1Refresh);
    at(4);
    const s2RefreshRes = await r.serveLoad(s2, s2Refresh);
    r.receiveLoad(s2, s2RefreshRes);
    r.receiveLoad(s1, s1RefreshRes);

    // 開始: 開始した画面には同期メッセージが応答より先に届く
    r.operate(s1);
    at(10);
    const started = await r.serveOp(s1, {});
    await r.receiveSync(s2);
    await r.receiveSync(s1);
    r.receiveOp(s1, started);

    // 一時停止: 応答が先、同じ変更の同期メッセージがあとから届く
    r.operate(s2);
    at(20);
    const paused = await r.serveOp(s2, { kind: "Pause" });
    r.receiveOp(s2, paused);
    await r.receiveSync(s1);
    await r.receiveSync(s2);

    // s1 が切れている間の再開は届かない。繋ぎ直して読み込み直すと追いつく
    r.disconnect(s1);
    r.operate(s2);
    at(30);
    const resumed = await r.serveOp(s2, { kind: "Resume" });
    r.receiveOp(s2, resumed);
    r.reconnect(s1);
    await r.accept(s1);
    const s1Again = r.opened(s1);
    at(40);
    r.receiveLoad(s1, await r.serveLoad(s1, s1Again));
    await r.receiveSync(s2);

    expect(shownVersion(s1)).toBe(3);
    expect(shownVersion(s2)).toBe(3);
    Object.assign(task.meta, { sessionSyncTrace: r.steps });
  });

  test("別の画面の開始と同じミリ秒に処理された読み込みが同期メッセージより後に届くと、画面は開始の前に戻る", async ({
    task,
  }) => {
    const r = recorder();
    const [s1, s1Mount] = r.mount("s1");
    const [s2, s2Mount] = r.mount("s2");
    at(1);
    r.receiveLoad(s1, await r.serveLoad(s1, s1Mount));
    at(2);
    r.receiveLoad(s2, await r.serveLoad(s2, s2Mount));
    await r.accept(s2);

    r.operate(s1);
    const s2Refresh = r.opened(s2);
    // Workers の時計は I/O まで進まないので、同時に届いた2つの要求は同じミリ秒に処理されうる
    at(10);
    const refreshed = await r.serveLoad(s2, s2Refresh);
    const started = await r.serveOp(s1, {});
    await r.receiveSync(s2);
    const afterSync = shownVersion(s2);
    r.receiveLoad(s2, refreshed);
    r.receiveOp(s1, started);

    expect(afterSync).toBe(1);
    // 巻き戻った（formal/session-sync の stall-rollback と同じ並び）
    expect(shownVersion(s2)).toBe(0);
    Object.assign(task.meta, { sessionSyncTrace: r.steps });
  });

  test("読み込み中に届いた開始の同期メッセージは捨てられ、変更より前の読み込みだけが届いた画面は開始の前のまま", async ({
    task,
  }) => {
    const r = recorder();
    const [s1, s1Mount] = r.mount("s1");
    const [s2, s2Mount] = r.mount("s2");
    await r.accept(s2);
    const s2Refresh = r.opened(s2);
    at(1);
    r.receiveLoad(s1, await r.serveLoad(s1, s1Mount));
    at(2);
    const s2MountRes = await r.serveLoad(s2, s2Mount);
    at(3);
    const s2RefreshRes = await r.serveLoad(s2, s2Refresh);

    r.operate(s1);
    at(10);
    const started = await r.serveOp(s1, {});
    r.receiveOp(s1, started);
    await r.receiveSync(s2);
    r.receiveLoad(s2, s2MountRes);
    r.receiveLoad(s2, s2RefreshRes);

    // UserDO はもう開始しているが、s2 は次の変更か繋ぎ直しまで知らない（formal/session-sync の liveness と同じ並び）
    expect(shownVersion(s1)).toBe(1);
    expect(shownVersion(s2)).toBe(0);
    Object.assign(task.meta, { sessionSyncTrace: r.steps });
  });
});
