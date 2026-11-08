import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import * as v from "valibot";
import { ApiErrorBodyJsonSchema } from "../domain/api-error.ts";
import { bearer, signInNatively } from "./native-auth-test-flow.ts";
import {
  exhaustRateLimit,
  prepareDatabase,
  request,
  resetStorage,
  signInAs,
} from "./workers-test-harness.ts";

/**
 * ネイティブアプリの Bearer トークンで、UserDO を通る API と同期の WebSocket を使う（ADR 0029）。
 * ログインの流れそのものは native-auth.test.ts で確かめる。
 */

const opened: Array<WebSocket> = [];

beforeEach(async () => {
  await prepareDatabase();
});

afterEach(async () => {
  for (const ws of opened.splice(0)) {
    ws.close();
  }
  await resetStorage();
});

const signIn = () =>
  signInNatively(
    request,
    async () => (await signInAs("me@example.com")).headers.get("cookie") ?? "",
  );

/** ネイティブアプリは Origin を送らない */
const upgrade = (headers: Headers) => {
  headers.set("upgrade", "websocket");
  return request("/api/ws", { headers });
};

describe("Bearer トークンでの同期の WebSocket", () => {
  test("トークンがあれば Origin なしでもつながり、別の端末で開始したセッションのスナップショットが届く", async () => {
    const token = await signIn();

    const res = await upgrade(bearer(token));
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
    const headers = bearer(token);
    headers.set("content-type", "application/json");
    await request("/api/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: crypto.randomUUID() }),
    });

    expect(res.status).toBe(101);
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(1));
    expect(JSON.parse(received[0] ?? "null")).toMatchObject({ kind: "SessionChanged" });
  });

  test("トークンがなければ 401 を返し、つながない", async () => {
    const res = await upgrade(new Headers());

    expect(res.status).toBe(401);
  });

  test("失効したトークンでは 401 を返し、つながない", async () => {
    const token = await signIn();
    await request("/api/auth/sign-out", { method: "POST", headers: bearer(token) });

    const res = await upgrade(bearer(token));

    expect(res.status).toBe(401);
  });
});

describe("Bearer トークンでの UserDO の API", () => {
  test("トークンで現在のセッションを読める", async () => {
    const token = await signIn();

    const res = await request("/api/session/current", { headers: bearer(token) });

    expect(res.status).toBe(200);
  });

  test("トークンでも、ユーザーごとのレート制限が画面と同じに効く", async () => {
    const token = await signIn();

    const { passed, rejected } = await exhaustRateLimit(bearer(token));

    expect(passed).toBe(100);
    expect(v.parse(ApiErrorBodyJsonSchema, await rejected.json()).error).toBe("RATE_LIMITED");
  });
});
