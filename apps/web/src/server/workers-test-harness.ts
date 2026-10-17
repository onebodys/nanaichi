import { applyD1Migrations, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";

/**
 * Durable Object を含む API を、Workers ランタイム（workerd）の上で検証するためのテスト用の土台。
 *
 * `auth-test-harness.ts` の Workers 版。Node では UserDO を動かせないので、セッションの API は
 * こちらで確かめる。D1 と UserDO は vitest-plugin が miniflare でローカルに用意する。
 * ログインは Google を通さず、Better Auth 公式の `testUtils` でユーザーとセッションを作る。
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
 * `testUtils` の `init` は `options` に `undefined` を返しうる型で、このリポジトリの
 * `exactOptionalPropertyTypes` と合わない（`auth-test-harness.ts` と同じ理由）。
 */
const testUtilsWithoutOptions = () => {
  const plugin = testUtils();
  return {
    id: plugin.id,
    version: plugin.version,
    init: (ctx) => ({ context: plugin.init(ctx).context }),
  } satisfies BetterAuthPlugin;
};

/**
 * 指定したメールアドレスのユーザーを作り、ログイン済みのセッションの cookie とユーザー ID を返す。
 * 許可リスト（vitest.workers.config.ts の `ALLOWED_EMAILS`）に載っているメールアドレスを使う。
 */
export const signInAs = async (
  email: string,
): Promise<Readonly<{ headers: Headers; userId: string }>> => {
  const testAuth = betterAuth({
    database: env.DB,
    // vitest.workers.config.ts が渡す `BETTER_AUTH_SECRET` と同じ値
    secret: "test-secret-value-that-is-long-enough",
    baseURL: ORIGIN,
    plugins: [testUtilsWithoutOptions()],
  });
  const helpers = (await testAuth.$context).test;
  const user = await helpers.saveUser(helpers.createUser({ email }));
  const { headers } = await helpers.login({ userId: user.id });
  return { headers, userId: user.id };
};

/** アプリ（Worker の default export）にリクエストする */
export const request = (path: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
