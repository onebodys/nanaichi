import { applyD1Migrations, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { vi } from "vite-plus/test";
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
    }
  }
}

/** アプリが許可しているホスト（`base-url.ts`）。ここ以外からのリクエストは 400 になる */
const ORIGIN = "http://localhost:5173";

/** 空の D1 に本番と同じマイグレーションを当てる。`beforeEach` で呼ぶ */
export const prepareDatabase = async (): Promise<void> => {
  await applyD1Migrations(env.DB, [...env.TEST_MIGRATIONS]);
};

/** D1 と UserDO の中身を消す。テスト同士でユーザーやセッションが混ざらないよう `afterEach` で呼ぶ */
export const resetStorage = (): Promise<void> => reset();

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

/** アプリ（Worker の default export）にリクエストする。`origin` を変えれば本番などのホストからとして送れる */
export const request = (path: string, init?: RequestInit, origin = ORIGIN): Promise<Response> =>
  exports.default.fetch(new Request(`${origin}${path}`, init));

/** テストでのレート制限の窓の長さ（vitest.workers.config.ts の `ratelimits`） */
const RATE_LIMIT_WINDOW_MS = 60_000;
/** 使い切ったあとの確認まで同じ窓に収めるために、窓に残っていてほしい時間 */
const RATE_LIMIT_WINDOW_ROOM_MS = 40_000;

/**
 * `headers` で数えられるレート制限を使い切る。通った回数と、弾かれた応答を返す。
 * 既定はログイン中のユーザーの制限（ADR 0018）で、`path` を変えればほかの制限も使い切れる。
 *
 * miniflare の窓は実時間の区切りで、区切りをまたぐと数が 0 に戻り、続く確認のリクエストが通ってしまう。
 * そこで窓の残りが少なければ次の窓を待つ。1回ずつ送るとマシンが混んだときに上限に届かないので、
 * 上限より多くを同時に送る。
 */
export const exhaustRateLimit = async (
  headers: Headers,
  path = "/api/session/current",
): Promise<Readonly<{ passed: number; rejected: Response }>> => {
  // `Date` を偽物にしているテストからも呼ぶので、本当の時刻を読む
  const left = RATE_LIMIT_WINDOW_MS - (vi.getRealSystemTime() % RATE_LIMIT_WINDOW_MS);
  if (left < RATE_LIMIT_WINDOW_ROOM_MS) {
    await new Promise((resolve) => setTimeout(resolve, left));
  }
  const responses = await Promise.all(
    Array.from({ length: 150 }, () => request(path, { headers, redirect: "manual" })),
  );
  const rejected = responses.find((res) => res.status === 429);
  if (rejected === undefined) {
    throw new Error("レート制限に達しなかった");
  }
  return { passed: responses.filter((res) => res.status !== 429).length, rejected };
};
