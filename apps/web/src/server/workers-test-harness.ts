import { applyD1Migrations, createExecutionContext, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";
import { app } from "./app.ts";
import { createTestAuth } from "./test-auth.ts";

/**
 * Durable Object を含む API を、Workers ランタイム（workerd）の上で検証するためのテスト用の土台。
 *
 * `auth-test-harness.ts` の Workers 版。Node では UserDO を動かせないので、セッションの API は
 * こちらで確かめる。D1 と UserDO は vitest-plugin が miniflare でローカルに用意する。
 * ログインは Google を通さず、Better Auth 公式の `testUtils` でユーザーとセッションを作る（`test-auth.ts`）。
 */

declare global {
  namespace Cloudflare {
    interface Env {
      /** vitest.workers.config.ts が渡す D1 のマイグレーション */
      readonly TEST_MIGRATIONS: ReadonlyArray<{ name: string; queries: string[] }>;
      // secret（env.ts）。vitest.workers.config.ts の `bindings` が渡す
      readonly BETTER_AUTH_SECRET: string;
      readonly GOOGLE_CLIENT_ID: string;
      readonly GOOGLE_CLIENT_SECRET: string;
      readonly ALLOWED_EMAILS: string;
    }
  }
}

/** アプリが許可しているホスト（`base-url.ts`）。ここ以外からのリクエストは 400 になる */
const ORIGIN = "http://localhost:5173";

/** 空の D1 に本番と同じマイグレーションを当てる。`beforeEach` で呼ぶ */
export const prepareDatabase = async (): Promise<void> => {
  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);
};

/**
 * 指定したメールアドレスのユーザーを作り、ログイン済みのセッションの cookie とユーザー ID を返す。
 * 許可リスト（vitest.workers.config.ts の `ALLOWED_EMAILS`）に載っているメールアドレスを使う。
 */
export const signInAs = async (
  email: string,
): Promise<Readonly<{ headers: Headers; userId: string }>> => {
  const { headers, userId } = await createTestAuth({
    database: env.DB,
    // vitest.workers.config.ts が渡す `BETTER_AUTH_SECRET` と同じ値
    secret: "test-secret-value-that-is-long-enough",
    baseURL: ORIGIN,
  }).signInAs(email);
  return { headers, userId };
};

/**
 * テストでのレート制限（ADR 0018）。miniflare の本物のレート制限は、窓が実時間の区切りで、テストから時計を動かせない。
 * マシンが混むと、使い切るまでのあいだに区切りをまたいで数が 0 に戻ったり、使い切るのが時間の上限に間に合わなかったりして、
 * 負荷しだいで結果が変わる（Issue #92）。そこで、時刻を見ずに数だけで決める偽物に差し替える。
 * 上限はテストが `limitRequestsTo` で決め、決めていないテストでは常に通す（auth-test-harness.ts と同じ）。
 * 本番の上限と窓（wrangler.jsonc の `ratelimits`）は Cloudflare が数えるもので、ここでは確かめない。
 * 確かめるのは、アプリがリクエストごとに正しいキーで数えさせ、断られたら UserDO を呼ばずに 429 を返すこと。
 */
const rateLimit = {
  limit: Number.POSITIVE_INFINITY,
  /** 制限の種類とキーごとの、通した回数 */
  counts: new Map<string, number>(),
};

const fakeRateLimiter = (name: string): RateLimit => ({
  limit: async ({ key }) => {
    const counted = `${name}:${key}`;
    const passed = rateLimit.counts.get(counted) ?? 0;
    if (passed >= rateLimit.limit) {
      return { success: false };
    }
    rateLimit.counts.set(counted, passed + 1);
    return { success: true };
  },
});

const testEnv: Env = {
  ...env,
  USER_RATE_LIMITER: fakeRateLimiter("user"),
  NATIVE_AUTH_RATE_LIMITER: fakeRateLimiter("native-auth"),
};

/** このテストのあいだ、レート制限の上限を、制限の種類とキーごとに `limit` 回にする。`afterEach` の `resetStorage` で戻る */
export const limitRequestsTo = (limit: number): void => {
  rateLimit.limit = limit;
};

/**
 * D1 と UserDO の中身を消し、レート制限の上限と数を戻す。
 * テスト同士でユーザーやセッションが混ざらないよう `afterEach` で呼ぶ
 */
export const resetStorage = (): Promise<void> => {
  rateLimit.limit = Number.POSITIVE_INFINITY;
  rateLimit.counts.clear();
  return reset();
};

/**
 * アプリにリクエストする。`origin` を変えれば本番などのホストからとして送れる。
 * レート制限を偽物にした `testEnv` で呼ぶので、Worker の default export（index.ts）ではなく `app` を直接呼ぶ
 */
export const request = (path: string, init?: RequestInit, origin = ORIGIN): Promise<Response> =>
  Promise.resolve(
    app.fetch(new Request(`${origin}${path}`, init), testEnv, createExecutionContext()),
  );

/**
 * `headers` で数えられるレート制限を使い切る。通った回数と、弾かれた応答を返す。
 * 既定はログイン中のユーザーの制限（ADR 0018）で、`path` を変えればほかの制限も使い切れる。
 * 上限は先に `limitRequestsTo` で決めておく。1回ずつ送り、弾かれるまで続ける
 */
export const exhaustRateLimit = async (
  headers: Headers,
  path = "/api/session/current",
): Promise<Readonly<{ passed: number; rejected: Response }>> => {
  if (rateLimit.limit === Number.POSITIVE_INFINITY) {
    throw new Error("先に limitRequestsTo で上限を決める");
  }
  for (let passed = 0; passed <= rateLimit.limit; passed++) {
    const res = await request(path, { headers, redirect: "manual" });
    if (res.status === 429) {
      return { passed, rejected: res };
    }
  }
  throw new Error("レート制限に達しなかった");
};

/**
 * 非同期に起きることを、起きるまで待って確かめる。`vi.waitFor` の既定の上限（1 秒）では、
 * マシンが混んでいるとき（push 時のフックが並行して走るなど）に、正しく動いていても時間切れで落ちる（Issue #31）。
 * 上限は振る舞いの検証ではなく、起きないまま止まったテストを見つけるためのもの（`vitest.workers.config.ts` の
 * `testTimeout` と同じ考え方）
 */
export const eventually = <T>(assertion: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(assertion, { timeout: 10_000 });
