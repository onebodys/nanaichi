import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import { AdvanceModeJsonSchema } from "../domain/advance-mode.ts";
import { schemaResult } from "../domain/schema-result.ts";
import { SessionSnapshotJsonSchema } from "../domain/session.ts";
import { SyncMessageJsonSchema } from "../domain/sync-message.ts";
import {
  eventually,
  prepareDatabase,
  request,
  resetStorage,
  signInAs,
} from "./workers-test-harness.ts";

// 時計の扱いは session-api.workers.test.ts と同じ。alarm がすぐ鳴らないよう、本当の時計より先の時刻でテストする
const STARTED_AT = Date.UTC(2100, 0, 1, 0, 0, 0);
const minutes = (m: number, s = 0) => STARTED_AT + m * 60_000 + s * 1000;

const passTo = (ms: number) => vi.setSystemTime(ms);

const ORIGIN = "http://localhost:5173";

let headers: Headers;
const opened: Array<WebSocket> = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  passTo(minutes(0));
  await prepareDatabase();
  ({ headers } = await signInAs("me@example.com"));
});

afterEach(async () => {
  for (const ws of opened.splice(0)) {
    ws.close();
  }
  vi.useRealTimers();
  await resetStorage();
});

const ALL_AUTO = {
  FocusToJournal: "Auto",
  JournalToFocus: "Auto",
  JournalToBreak: "Auto",
  BreakToFocus: "Auto",
} as const;
const MANUAL_FOCUS_TO_JOURNAL = { ...ALL_AUTO, FocusToJournal: "Manual" } as const;

const withBody = (method: string, body: unknown, h: Headers = headers): RequestInit => ({
  method,
  headers: { cookie: h.get("cookie") ?? "", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const getMode = (h: Headers = headers) => request("/api/settings/advance-mode", { headers: h });
const putMode = (mode: unknown, h: Headers = headers) =>
  request("/api/settings/advance-mode", withBody("PUT", mode, h));
const getCurrent = () => request("/api/session/current", { headers });
const start = () => request("/api/session", withBody("POST", { id: crypto.randomUUID() }));
const operate = (kind: string) =>
  request("/api/session/commands", withBody("POST", { id: crypto.randomUUID(), kind }));

/** 応答が画面と同じスキーマに合うことを確かめてから返す（ADR 0009） */
const snapshotOf = async (res: Response) => {
  const parsed = schemaResult(SessionSnapshotJsonSchema)(await res.json());
  expect(Result.isSuccess(parsed)).toBe(true);
  return Result.isSuccess(parsed) ? parsed.value : undefined;
};

const connect = async () => {
  const res = await request("/api/ws", {
    headers: { cookie: headers.get("cookie") ?? "", upgrade: "websocket", origin: ORIGIN },
  });
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
  return received;
};

describe("ログインしていないとき", () => {
  test.each(["GET", "PUT"])("%s /api/settings/advance-mode は 401 を返す", async (method) => {
    const res = await request("/api/settings/advance-mode", { method });

    expect(res.status).toBe(401);
  });
});

describe("フェーズの進め方の読み書き", () => {
  test("変えたことがなければ、すべての切り替わりが自動", async () => {
    const res = await getMode();

    expect(res.status).toBe(200);
    expect(schemaResult(AdvanceModeJsonSchema)(await res.json())).toEqual(Result.succeed(ALL_AUTO));
  });

  test("変えた進め方は、読み直しても同じで、別の端末（別のログイン）から見ても同じ", async () => {
    const put = await putMode(MANUAL_FOCUS_TO_JOURNAL);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(MANUAL_FOCUS_TO_JOURNAL);

    // 同じユーザーの別のセッション（別の端末にあたる）
    const other = await signInAs("me@example.com");
    expect(await (await getMode(other.headers)).json()).toEqual(MANUAL_FOCUS_TO_JOURNAL);
  });

  test("進め方はユーザーごとで、他のユーザーには効かない", async () => {
    await putMode(MANUAL_FOCUS_TO_JOURNAL);
    const someone = await signInAs("someone@example.com");

    expect(await (await getMode(someone.headers)).json()).toEqual(ALL_AUTO);
  });

  test("自動・手動のどちらでもない値や、足りない切り替わりは 400 で断る", async () => {
    const res = await putMode({ ...ALL_AUTO, BreakToFocus: "Sometimes" });
    const missing = await putMode({ FocusToJournal: "Manual" });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVALID_REQUEST" });
    expect(missing.status).toBe(400);
  });
});

describe("手動の切り替わりのあるセッション", () => {
  test("集中 → ジャーナルを手動にすると、時間が過ぎても 0:00 の切り替え待ちで止まり、進めると押した時刻からジャーナルが始まる", async () => {
    await putMode(MANUAL_FOCUS_TO_JOURNAL);
    await start();
    passTo(minutes(9));

    expect(await snapshotOf(await getCurrent())).toMatchObject({
      state: {
        kind: "AwaitingAdvance",
        finished: { kind: "Focus", round: 1, setNumber: 1 },
        completedSets: 1,
        since: new Date(minutes(7)),
      },
    });

    const advanced = await operate("Advance");

    expect(advanced.status).toBe(200);
    passTo(minutes(9, 20));
    expect(await snapshotOf(await getCurrent())).toMatchObject({
      state: { kind: "Journal", setNumber: 1, remainingSeconds: 40 },
    });
  });

  test("同じ切り替え待ちで2回進めると、2回目は 409 を返す（別の端末で同時に押したとき）", async () => {
    await putMode(MANUAL_FOCUS_TO_JOURNAL);
    await start();
    passTo(minutes(8));
    await operate("Advance");

    const second = await operate("Advance");

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: "OPERATION_REJECTED",
      operation: "Advance",
      during: "Journal",
    });
  });

  test("待っている切り替わりを自動に戻すと、その時刻から次のフェーズが始まる", async () => {
    await putMode(MANUAL_FOCUS_TO_JOURNAL);
    await start();
    passTo(minutes(10));

    await putMode(ALL_AUTO);
    passTo(minutes(10, 15));

    expect(await snapshotOf(await getCurrent())).toMatchObject({
      state: { kind: "Journal", setNumber: 1, remainingSeconds: 45 },
    });
  });

  test("セッション中に変えると、新しい進め方と新しいスナップショットを同期で配る", async () => {
    await start();
    const received = await connect();
    passTo(minutes(3));

    await putMode(MANUAL_FOCUS_TO_JOURNAL);

    await eventually(() => expect(received.length).toBeGreaterThanOrEqual(2));
    const [mode, session] = received.map((data) =>
      schemaResult(SyncMessageJsonSchema)(JSON.parse(data)),
    );
    expect(mode).toEqual(
      Result.succeed({ kind: "AdvanceModeChanged", mode: MANUAL_FOCUS_TO_JOURNAL }),
    );
    expect(session).toMatchObject({
      type: "Success",
      value: {
        kind: "SessionChanged",
        snapshot: {
          session: { advanceModeChanges: [{ at: new Date(minutes(3)) }] },
          state: { kind: "Focus" },
        },
      },
    });
  });

  test("同じ進め方を送っても何も記録せず、同期も送らない", async () => {
    const received = await connect();

    const res = await putMode(ALL_AUTO);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(res.status).toBe(200);
    expect(received).toEqual([]);
  });

  test("セッションを始める前の変更は、始めたセッションに引き継がれる", async () => {
    await putMode(MANUAL_FOCUS_TO_JOURNAL);
    passTo(minutes(1));

    const started = await snapshotOf(await start());

    expect(started).toMatchObject({
      session: {
        advanceModeChanges: [{ at: new Date(minutes(0)), mode: MANUAL_FOCUS_TO_JOURNAL }],
      },
    });
  });
});
