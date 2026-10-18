import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import { schemaResult } from "../domain/schema-result.ts";
import { SyncMessageJsonSchema } from "../domain/sync-message.ts";
import { prepareDatabase, request, resetStorage, signInAs } from "./workers-test-harness.ts";

// 時計の扱いは session-api.workers.test.ts と同じ。alarm がすぐ鳴らないよう、本当の時計より先の時刻でテストする
const STARTED_AT = Date.UTC(2100, 0, 1, 0, 0, 0);
const minutes = (m: number, s = 0) => STARTED_AT + m * 60_000 + s * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const passTo = (ms: number) => vi.setSystemTime(ms);

const ORIGIN = "http://localhost:5173";

let headers: Headers;
let userId: string;
const opened: Array<WebSocket> = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  passTo(minutes(0));
  await prepareDatabase();
  ({ headers, userId } = await signInAs("me@example.com"));
});

afterEach(async () => {
  for (const ws of opened.splice(0)) {
    ws.close();
  }
  vi.useRealTimers();
  await resetStorage();
});

const cookieOf = (h: Headers) => h.get("cookie") ?? "";

/** `origin` が null なら Origin を付けない */
const upgrade = (h: Headers, origin: string | null = ORIGIN) =>
  request("/api/ws", {
    headers: {
      cookie: cookieOf(h),
      upgrade: "websocket",
      ...(origin === null ? {} : { origin }),
    },
  });

/** 同期の WebSocket を開き、届いた文字列を順にためる（1つのタブ・端末にあたる） */
const connect = async (h: Headers = headers) => {
  const res = await upgrade(h);
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (ws === null) {
    throw new Error("WebSocket が返ってこなかった");
  }
  ws.accept();
  opened.push(ws);
  const received: Array<string> = [];
  ws.addEventListener("message", (event) => {
    received.push(typeof event.data === "string" ? event.data : "(binary)");
  });
  return { ws, received };
};

/** 画面と同じく、届いた文字列を JSON にしてからスキーマで検証する */
const decode = (data: string | undefined) =>
  schemaResult(SyncMessageJsonSchema)(JSON.parse(data ?? "null"));

/** 届くまで待つ。WebSocket のメッセージは HTTP の応答より後に届くことがある */
const waitFor = async (received: Array<string>, count: number) =>
  vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(count));

/** メッセージが届かないことを確かめるために、届くはずなら届くまでの時間だけ待つ */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const withBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { cookie: cookieOf(headers), "content-type": "application/json" },
  body: JSON.stringify(body),
});

const start = () => request("/api/session", withBody("POST", { id: crypto.randomUUID() }));
const operate = (kind: string) =>
  request("/api/session/commands", withBody("POST", { id: crypto.randomUUID(), kind }));
const write = (body: string, id: string = crypto.randomUUID()) =>
  request("/api/journal-entries", withBody("POST", { id, body }));

describe("接続", () => {
  test("ログインしていなければ 401 を返し、繋がない", async () => {
    const res = await request("/api/ws", { headers: { upgrade: "websocket", origin: ORIGIN } });

    expect(res.status).toBe(401);
  });

  test("WebSocket の Upgrade でなければ 426 を返す", async () => {
    const res = await request("/api/ws", { headers });

    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({ error: "WEBSOCKET_UPGRADE_REQUIRED" });
  });

  test.each([
    ["別のサイト", "https://evil.example.com"],
    ["Origin なし", null],
  ])("%s からの接続は 403 を返し、繋がない", async (_, origin) => {
    const res = await upgrade(headers, origin);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "CROSS_ORIGIN_REJECTED" });
  });

  test("ping を送ると pong が返る（切れたことに気づくため）", async () => {
    const { ws, received } = await connect();

    ws.send("ping");

    await waitFor(received, 1);
    expect(received).toEqual(["pong"]);
  });
});

describe("セッションの同期", () => {
  test("別のタブで開始すると、開いているすべての接続に新しいスナップショットが届く", async () => {
    const pc = await connect();
    const phone = await connect();

    await start();

    await waitFor(pc.received, 1);
    await waitFor(phone.received, 1);
    for (const { received } of [pc, phone]) {
      expect(received).toHaveLength(1);
      const message = decode(received[0]);
      expect(Result.isSuccess(message) && message.value).toMatchObject({
        kind: "SessionChanged",
        snapshot: {
          kind: "Session",
          serverTime: new Date(minutes(0)),
          state: { kind: "Focus", round: 1, setNumber: 1 },
        },
      });
    }
  });

  test("一時停止すると、一時停止したスナップショットが届く", async () => {
    await start();
    const phone = await connect();
    passTo(minutes(2));

    await operate("Pause");

    await waitFor(phone.received, 1);
    const message = decode(phone.received[0]);
    expect(Result.isSuccess(message) && message.value).toMatchObject({
      kind: "SessionChanged",
      snapshot: {
        state: { kind: "Focus", clock: { kind: "Paused", pausedAt: new Date(minutes(2)) } },
      },
    });
  });

  test("受け付けられなかった操作では何も届かない", async () => {
    await start();
    const phone = await connect();

    const res = await operate("SkipBreak");

    expect(res.status).toBe(409);
    await settle();
    expect(phone.received).toEqual([]);
  });

  test("他のユーザーの操作は届かない", async () => {
    const other = await signInAs("someone@example.com");
    const othersPhone = await connect(other.headers);

    await start();

    await settle();
    expect(othersPhone.received).toEqual([]);
  });

  test("自動終了の alarm では何も届かない（どの画面も時刻から自動終了を計算している）", async () => {
    await start();
    const phone = await connect();
    passTo(minutes(58));

    await runDurableObjectAlarm(env.USER_DO.getByName(userId));

    await settle();
    expect(phone.received).toEqual([]);
  });
});

describe("ジャーナル記入の同期", () => {
  test("記入を書くと、記入と、自動終了の時刻が延びた新しいスナップショットが届く", async () => {
    await start();
    const phone = await connect();
    passTo(minutes(3));
    const id = crypto.randomUUID();

    await write("設計を書いた", id);

    await waitFor(phone.received, 2);
    const saved = decode(phone.received[0]);
    const changed = decode(phone.received[1]);
    expect(Result.isSuccess(saved) && saved.value).toMatchObject({
      kind: "JournalEntrySaved",
      entry: {
        id,
        writtenAt: new Date(minutes(3)),
        writtenDuring: { kind: "Focus", setNumber: 1 },
      },
    });
    expect(
      Result.isSuccess(saved) &&
        saved.value.kind === "JournalEntrySaved" &&
        saved.value.entry.body.unwrap(),
    ).toBe("設計を書いた");
    expect(Result.isSuccess(changed) && changed.value).toMatchObject({
      kind: "SessionChanged",
      snapshot: { session: { journalEntryTimes: [new Date(minutes(3))] } },
    });
  });

  test("記入を編集すると、書き直した記入がタグとともに届く", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("設計を書いた", id);
    const phone = await connect();
    passTo(minutes(4));

    await request(
      `/api/journal-entries/${id}`,
      withBody("PATCH", {
        body: "設計を書き直した",
        tags: ["設計"],
      }),
    );

    await waitFor(phone.received, 1);
    expect(JSON.parse(phone.received[0] ?? "null")).toMatchObject({
      kind: "JournalEntrySaved",
      entry: { id, body: "設計を書き直した", tags: ["設計"], updatedAt: iso(minutes(4)) },
    });
  });

  test("記入を削除すると、削除した記入の ID が届く", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("設計を書いた", id);
    const phone = await connect();
    passTo(minutes(5));

    await request(`/api/journal-entries/${id}`, { method: "DELETE", headers });

    await waitFor(phone.received, 1);
    const message = decode(phone.received[0]);
    expect(Result.isSuccess(message) && message.value).toEqual({
      kind: "JournalEntryDeleted",
      deleted: { id, deletedAt: new Date(minutes(5)) },
    });
  });
});
