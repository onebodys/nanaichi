import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import * as v from "valibot";
import { SessionEventId } from "../domain/session-event.ts";
import { Session, SessionId } from "../domain/session.ts";
import { SyncMessage } from "../domain/sync-message.ts";
import { connectSync, type OpenSyncSocket } from "./sync-connection.ts";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 17, 0, minutes, 0));
const started = Session.start(
  v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000000"),
  v.parse(SessionEventId.schema, "00000000-0000-4000-8000-000000000001"),
  at(0),
);
const sessionChanged: SyncMessage = {
  kind: "SessionChanged",
  snapshot: Session.snapshot(started, at(1)),
};

/** サーバーの代わりに、開かれた WebSocket を記録し、テストからイベントを起こせるようにする */
const fakeServer = () => {
  const sockets: Array<{
    open: () => void;
    receive: (data: unknown) => void;
    drop: () => void;
    sent: Array<string>;
    closed: boolean;
  }> = [];
  const openSocket: OpenSyncSocket = ({ onOpen, onMessage, onClose }) => {
    const socket = {
      open: onOpen,
      receive: onMessage,
      drop: onClose,
      sent: new Array<string>(),
      closed: false,
    };
    sockets.push(socket);
    return {
      send: (data) => socket.sent.push(data),
      close: () => {
        socket.closed = true;
      },
    };
  };
  const latest = () => {
    const socket = sockets.at(-1);
    if (socket === undefined) {
      throw new Error("まだ開いていない");
    }
    return socket;
  };
  return { sockets, latest, openSocket };
};

const handlers = () => ({ onConnected: vi.fn<() => void>(), onMessage: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("接続", () => {
  test("繋がったら読み込み直すよう知らせる", () => {
    const server = fakeServer();
    const on = handlers();
    connectSync(on, server.openSocket);

    expect(on.onConnected).not.toHaveBeenCalled();
    server.latest().open();

    expect(on.onConnected).toHaveBeenCalledTimes(1);
  });

  test("届いた同期メッセージを検証して渡す", () => {
    const server = fakeServer();
    const on = handlers();
    connectSync(on, server.openSocket);
    server.latest().open();

    server.latest().receive(SyncMessage.serialize(sessionChanged));

    expect(on.onMessage).toHaveBeenCalledWith(sessionChanged);
  });

  test.each([
    ["JSON でないもの", "not json"],
    ["スキーマに合わないもの", JSON.stringify({ kind: "Unknown" })],
    ["文字列でないもの", new ArrayBuffer(1)],
  ])("%s は捨てる", (_, data) => {
    const server = fakeServer();
    const on = handlers();
    connectSync(on, server.openSocket);
    server.latest().open();

    server.latest().receive(data);

    expect(on.onMessage).not.toHaveBeenCalled();
  });
});

describe("切断と繋ぎ直し", () => {
  test("切れたら1秒後に繋ぎ直し、繋がったらまた読み込み直すよう知らせる", () => {
    const server = fakeServer();
    const on = handlers();
    connectSync(on, server.openSocket);
    server.latest().open();

    server.latest().drop();
    vi.advanceTimersByTime(999);
    expect(server.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(server.sockets).toHaveLength(2);
    server.latest().open();

    expect(on.onConnected).toHaveBeenCalledTimes(2);
  });

  test("繋がらないまま失敗が続くと、間隔を倍にしながら最大30秒まで延ばす", () => {
    const server = fakeServer();
    connectSync(handlers(), server.openSocket);
    const waited: Array<number> = [];

    for (let i = 0; i < 7; i++) {
      const before = server.sockets.length;
      server.latest().drop();
      let ms = 0;
      while (server.sockets.length === before) {
        vi.advanceTimersByTime(1000);
        ms += 1000;
      }
      waited.push(ms);
    }

    expect(waited).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  });

  test("繋がったら、次に切れたときの間隔は1秒に戻る", () => {
    const server = fakeServer();
    connectSync(handlers(), server.openSocket);
    server.latest().drop();
    vi.advanceTimersByTime(1000);
    server.latest().drop();
    vi.advanceTimersByTime(2000);
    server.latest().open();

    server.latest().drop();
    vi.advanceTimersByTime(1000);

    expect(server.sockets).toHaveLength(4);
  });

  test("25秒ごとに ping を送り、10秒以内に pong が返らなければ切って繋ぎ直す", () => {
    const server = fakeServer();
    connectSync(handlers(), server.openSocket);
    const first = server.latest();
    first.open();

    vi.advanceTimersByTime(25_000);
    expect(first.sent).toEqual(["ping"]);
    first.receive("pong");
    vi.advanceTimersByTime(25_000);
    expect(first.sent).toEqual(["ping", "ping"]);
    vi.advanceTimersByTime(10_000);

    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(server.sockets).toHaveLength(2);
  });

  test("捨てた接続から遅れて届いたメッセージや切断は無視する", () => {
    const server = fakeServer();
    const on = handlers();
    connectSync(on, server.openSocket);
    const first = server.latest();
    first.open();
    vi.advanceTimersByTime(35_000);

    first.receive(SyncMessage.serialize(sessionChanged));
    first.drop();
    vi.advanceTimersByTime(1000);

    expect(on.onMessage).not.toHaveBeenCalled();
    expect(server.sockets).toHaveLength(2);
  });
});

describe("画面に戻ってきたときの確認", () => {
  test("繋ぎ直しを待っている間なら、待たずにすぐ繋ぎ直す", () => {
    const server = fakeServer();
    const connection = connectSync(handlers(), server.openSocket);
    server.latest().drop();

    connection.check();

    expect(server.sockets).toHaveLength(2);
    vi.advanceTimersByTime(30_000);
    expect(server.sockets).toHaveLength(2);
  });

  test("繋がっているなら ping を送って確かめる", () => {
    const server = fakeServer();
    const connection = connectSync(handlers(), server.openSocket);
    server.latest().open();

    connection.check();

    expect(server.latest().sent).toEqual(["ping"]);
  });
});

describe("閉じる", () => {
  test("閉じたら接続を閉じ、もう繋ぎ直さない", () => {
    const server = fakeServer();
    const connection = connectSync(handlers(), server.openSocket);
    server.latest().open();

    connection.close();
    server.latest().drop();
    vi.advanceTimersByTime(60_000);

    expect(server.latest().closed).toBe(true);
    expect(server.sockets).toHaveLength(1);
  });

  test("繋ぎ直しを待っている間に閉じたら、もう繋ぎ直さない", () => {
    const server = fakeServer();
    const connection = connectSync(handlers(), server.openSocket);
    server.latest().drop();

    connection.close();
    vi.advanceTimersByTime(60_000);

    expect(server.sockets).toHaveLength(1);
  });
});
