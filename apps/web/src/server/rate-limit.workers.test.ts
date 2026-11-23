import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { ApiErrorBodyJsonSchema } from "../domain/api-error.ts";
import {
  exhaustRateLimit,
  limitRequestsTo,
  prepareDatabase,
  request,
  resetStorage,
  signInAs,
} from "./workers-test-harness.ts";

/** テストでの上限。本番の上限（wrangler.jsonc）は Cloudflare が数えるので、少ない回数で確かめる（workers-test-harness.ts） */
const LIMIT = 3;

beforeEach(async () => {
  await prepareDatabase();
  limitRequestsTo(LIMIT);
});

afterEach(async () => {
  await resetStorage();
});

describe("UserDO へのリクエストの制限", () => {
  test("上限の回数までは通り、超えると 429 と RATE_LIMITED と Retry-After を返す", async () => {
    const { headers } = await signInAs("me@example.com");

    const { passed, rejected } = await exhaustRateLimit(headers);

    expect(passed).toBe(LIMIT);
    expect(rejected.headers.get("retry-after")).toBe("10");
    expect(v.parse(ApiErrorBodyJsonSchema, await rejected.json()).error).toBe("RATE_LIMITED");
  });

  test("制限に達したあとのセッションの開始は UserDO に届かず、セッションは始まらない", async () => {
    const { headers, userId } = await signInAs("me@example.com");
    await exhaustRateLimit(headers);

    const res = await request("/api/session", {
      method: "POST",
      headers: { cookie: headers.get("cookie") ?? "", "content-type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID() }),
    });

    expect(res.status).toBe(429);
    const sessions = await runInDurableObject(env.USER_DO.getByName(userId), (_, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS n FROM sessions").one(),
    );
    expect(sessions["n"]).toBe(0);
  });

  test("制限はユーザーごとに数え、ほかのユーザーには影響しない", async () => {
    const me = await signInAs("me@example.com");
    const someone = await signInAs("someone@example.com");
    await exhaustRateLimit(me.headers);

    const res = await request("/api/session/current", { headers: someone.headers });

    expect(res.status).toBe(200);
  });

  test("同期の WebSocket の接続も数える", async () => {
    const { headers } = await signInAs("me@example.com");
    await exhaustRateLimit(headers);

    const res = await request("/api/ws", {
      headers: {
        cookie: headers.get("cookie") ?? "",
        upgrade: "websocket",
        origin: "http://localhost:5173",
      },
    });

    expect(res.status).toBe(429);
  });
});
