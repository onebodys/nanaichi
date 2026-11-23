import { Request, Response } from "miniflare";
import { describe, expect, test } from "vite-plus/test";
import { retryOnStaleConnection } from "./auth-test-harness.ts";

/** undici が閉じた接続で断られたときに投げるのと同じ形のエラー */
const fetchFailed = (code: string): TypeError =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

/** 投げるエラーを順に返し、尽きたら受け取った本文を返す dispatchFetch。受け取った要求の本文を記録する */
const fakeDispatchFetch = (errors: readonly unknown[]) => {
  const bodies: string[] = [];
  let calls = 0;
  const dispatchFetch = async (input: ConstructorParameters<typeof Request>[0]) => {
    const body = await new Request(input).text();
    bodies.push(body);
    const error = errors[calls];
    calls += 1;
    if (error !== undefined) {
      throw error;
    }
    return new Response(body);
  };
  return { dispatchFetch, bodies };
};

const post = { method: "POST", body: "select 1" } as const;

describe("テスト用の土台が miniflare への要求を送り直す（Issue #102）", () => {
  test("閉じた接続で ECONNRESET になった要求は、同じ本文で1度だけ送り直して応答を返す", async () => {
    const fake = fakeDispatchFetch([fetchFailed("ECONNRESET")]);

    const res = await retryOnStaleConnection(fake.dispatchFetch, () => {})(
      "http://localhost/",
      post,
    );

    expect(await res.text()).toBe("select 1");
    expect(fake.bodies).toEqual(["select 1", "select 1"]);
  });

  test("FIN を先に読んで UND_ERR_SOCKET になった要求も送り直す", async () => {
    const fake = fakeDispatchFetch([fetchFailed("UND_ERR_SOCKET")]);

    const res = await retryOnStaleConnection(fake.dispatchFetch, () => {})(
      "http://localhost/",
      post,
    );

    expect(res.status).toBe(200);
    expect(fake.bodies).toHaveLength(2);
  });

  test("送り直しても断られたら、そのエラーで失敗する", async () => {
    const fake = fakeDispatchFetch([fetchFailed("ECONNRESET"), fetchFailed("ECONNRESET")]);

    await expect(
      retryOnStaleConnection(fake.dispatchFetch, () => {})("http://localhost/", post),
    ).rejects.toThrow("fetch failed");
    expect(fake.bodies).toHaveLength(2);
  });

  test("接続が切れたのではない失敗は送り直さない", async () => {
    const fake = fakeDispatchFetch([fetchFailed("ECONNREFUSED")]);

    await expect(
      retryOnStaleConnection(fake.dispatchFetch, () => {})("http://localhost/", post),
    ).rejects.toThrow("fetch failed");
    expect(fake.bodies).toHaveLength(1);
  });

  test("要求を受け取ったことを知らせる（差し替えが効いているかを確かめるのに使う）", async () => {
    const fake = fakeDispatchFetch([]);
    let dispatched = 0;

    await retryOnStaleConnection(fake.dispatchFetch, () => {
      dispatched += 1;
    })("http://localhost/", post);

    expect(dispatched).toBe(1);
  });
});
