import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";

/**
 * Google を通さずにログイン済みのセッションを作るための、Better Auth のテスト専用インスタンス。
 *
 * 使うのは API のテストの土台（`auth-test-harness.ts` / `workers-test-harness.ts`）と、
 * ローカルの開発サーバーと E2E でだけ有効になるテスト用のログイン（`test-sign-in.ts`）。
 *
 * `testUtils` は本番の設定（`auth.ts`）に入れたくないので、同じ D1 と secret を共有する別の
 * インスタンスに入れる。セッションは D1 に保存され、cookie は secret で署名されるので、
 * アプリ側のインスタンスからもそのまま有効なセッションとして見える。
 */

/**
 * `testUtils` の `init` は `options` に `undefined` を返しうる型で、このリポジトリの
 * `exactOptionalPropertyTypes` と合わない。`options` は OTP の捕捉（`captureOTP`）に
 * しか使われず、ここでは使わないので、`context`（`ctx.test`）だけを渡す。
 */
const testUtilsWithoutOptions = () => {
  const plugin = testUtils();
  return {
    id: plugin.id,
    version: plugin.version,
    init: (ctx) => ({ context: plugin.init(ctx).context }),
  } satisfies BetterAuthPlugin;
};

type TestAuthConfig = Readonly<{
  database: D1Database;
  /** アプリと同じ `BETTER_AUTH_SECRET`。違うと cookie の署名がアプリに通らない */
  secret: string;
  /** アプリが許可しているホストの origin（`base-url.ts`）。cookie の名前と属性がこれで決まる */
  baseURL: string;
}>;

/** ログイン済みのセッション */
type TestLogin = Readonly<{
  userId: string;
  /** そのセッションの cookie を載せたリクエストヘッダ（API のテスト用） */
  headers: Headers;
  /** ブラウザに渡す `Set-Cookie` の値（テスト用のログイン用） */
  setCookies: ReadonlyArray<string>;
}>;

export type TestAuth = Readonly<{
  /**
   * 指定したメールアドレスのユーザーでログインする。ユーザーがいなければ作る。
   * 許可リストの照合（ユーザー作成時のガード）は通らない。照合が要るなら呼ぶ側で行う。
   */
  signInAs: (email: string) => Promise<TestLogin>;
}>;

type TestCookie = Awaited<
  ReturnType<Awaited<ReturnType<typeof testAuthInstance>["$context"]>["test"]["login"]>
>["cookies"][number];

const testAuthInstance = (config: TestAuthConfig) =>
  betterAuth({
    database: config.database,
    secret: config.secret,
    baseURL: config.baseURL,
    plugins: [testUtilsWithoutOptions()],
  });

/** `testUtils` が返す cookie を `Set-Cookie` の値にする。値は署名済みでそのまま使える */
const toSetCookie = (cookie: TestCookie): string =>
  [
    `${cookie.name}=${cookie.value}`,
    `Path=${cookie.path}`,
    ...(cookie.expires === undefined
      ? []
      : [`Expires=${new Date(cookie.expires * 1000).toUTCString()}`]),
    ...(cookie.httpOnly === true ? ["HttpOnly"] : []),
    ...(cookie.secure === true ? ["Secure"] : []),
    ...(cookie.sameSite === undefined ? [] : [`SameSite=${cookie.sameSite}`]),
  ].join("; ");

/**
 * インスタンスはログインするときに作る。Better Auth は作った時点で非同期に DB の初期化を始めるため、
 * 先に作っておくと、ログインしないまま D1 を止めたテストで初期化が失敗する。
 */
export const createTestAuth = (config: TestAuthConfig): TestAuth => ({
  signInAs: async (email) => {
    const context = await testAuthInstance(config).$context;
    const helpers = context.test;
    const found = await context.internalAdapter.findUserByEmail(email);
    const user = found?.user ?? (await helpers.saveUser(helpers.createUser({ email })));
    const login = await helpers.login({ userId: user.id });
    return {
      userId: user.id,
      headers: login.headers,
      setCookies: login.cookies.map(toSetCookie),
    };
  },
});
