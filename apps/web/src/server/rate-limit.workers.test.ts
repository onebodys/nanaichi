import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { ApiErrorBodyJsonSchema } from "../domain/api-error.ts";
import { prepareDatabase, request, resetStorage, signInAs } from "./workers-test-harness.ts";

// 制限は wrangler.jsonc の `ratelimits`（10 秒で 100 回）。miniflare も同じ設定で数える。
// 窓が明けるのを待つと 10 秒かかるので、窓が明けたあとの振る舞い（Cloudflare の仕組み）はテストしない
const LIMIT = 100;

beforeEach(async () => {
  await prepareDatabase();
});

afterEach(async () => {
  await resetStorage();
});

const currentSession = (headers: Headers) => request("/api/session/current", { headers });

const useUp = async (headers: Headers): Promise<ReadonlyArray<number>> => {
  const statuses: number[] = [];
  for (let i = 0; i < LIMIT; i += 1) {
    statuses.push((await currentSession(headers)).status);
  }
  return statuses;
};

describe("UserDO へのリクエストの制限", () => {
  test("10 秒に 100 回までは通る", async () => {
    const { headers } = await signInAs("me@example.com");

    const statuses = await useUp(headers);

    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  test("101 回目は 429 と RATE_LIMITED と Retry-After を返す", async () => {
    const { headers } = await signInAs("me@example.com");
    await useUp(headers);

    const res = await currentSession(headers);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("10");
    expect(v.parse(ApiErrorBodyJsonSchema, await res.json()).error).toBe("RATE_LIMITED");
  });

  test("制限に達したあとのセッションの開始は UserDO に届かず、セッションは始まらない", async () => {
    const { headers, userId } = await signInAs("me@example.com");
    await useUp(headers);

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
    await useUp(me.headers);

    const res = await currentSession(someone.headers);

    expect(res.status).toBe(200);
  });

  test("同期の WebSocket の接続も数える", async () => {
    const { headers } = await signInAs("me@example.com");
    await useUp(headers);

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
