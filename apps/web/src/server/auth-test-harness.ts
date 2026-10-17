import { readdir, readFile } from "node:fs/promises";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { app } from "./app.ts";

/**
 * 認証が絡む API を、Cloudflare や Google に繋がずにローカルで検証するためのテスト用の土台。
 *
 * - DB は miniflare の D1 を Node 上で動かし、本番と同じ `migrations/` を当てる
 *   （本物の D1 と同じ実装なので、SQL の方言の違いを気にしなくてよい）
 * - ログインは Google を通さず、Better Auth 公式の `testUtils` でユーザーとセッションを作る。
 *   `testUtils` は本番の設定に入れたくないので、同じ D1 と secret を共有するテスト専用の
 *   インスタンスに入れる。セッションは D1 に保存され、cookie は secret で署名されるので、
 *   アプリ側のインスタンスからもそのまま有効なセッションとして見える。
 */

const SECRET = "test-secret-value-that-is-long-enough";

/** アプリが許可しているホスト（`base-url.ts`）。ここ以外からのリクエストは 400 になる */
const ORIGIN = "http://localhost:5173";

// Worker 用の型（worker-configuration.d.ts）の URL は Node の URL と別物なので、パスは文字列で扱う
const MIGRATIONS_DIR = `${import.meta.dirname}/../../migrations`;

/** `migrations/*.sql` をファイル名の順に当てる。`wrangler d1 migrations apply` と同じ順序 */
const applyMigrations = async (db: D1Database): Promise<void> => {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).toSorted();

  for (const file of files) {
    const sql = await readFile(`${MIGRATIONS_DIR}/${file}`, "utf8");
    const statements = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
};

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

export type AuthHarness = Readonly<{
  /**
   * 指定したメールアドレスのユーザーを作り、ログイン済みのセッションの cookie を返す。
   * 許可リストの照合（ユーザー作成時のガード）は通らないので、「あとから許可リストから
   * 外れたユーザー」も作れる。
   */
  signInAs: (email: string) => Promise<Headers>;
  /** アプリに対してリクエストする */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** miniflare を止める。`afterEach` などで必ず呼ぶ */
  dispose: () => Promise<void>;
}>;

/**
 * 空の D1 を用意し、許可リストが `allowedEmails` のアプリを動かす。
 * テストごとに作れば、テスト同士でユーザーやセッションが混ざらない。
 */
export const startAuthHarness = async (allowedEmails: string): Promise<AuthHarness> => {
  // miniflare 5 は設定の形が変わったが、D1 を1つ動かすだけなら v4 形式の方が短く書ける。
  // 永続化を指定していないので D1 はメモリ上にでき、dispose で消える。
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {}",
      d1Databases: ["DB"],
    }),
  );
  const db = await miniflare.getD1Database("DB");
  await applyMigrations(db);

  const env = {
    DB: db,
    BETTER_AUTH_SECRET: SECRET,
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    ALLOWED_EMAILS: allowedEmails,
  } satisfies Partial<Env>;

  const testAuth = betterAuth({
    database: db,
    secret: SECRET,
    baseURL: ORIGIN,
    plugins: [testUtilsWithoutOptions()],
  });
  const helpers = (await testAuth.$context).test;

  return {
    signInAs: async (email) => {
      const user = await helpers.saveUser(helpers.createUser({ email }));
      const { headers } = await helpers.login({ userId: user.id });
      return headers;
    },
    request: async (path, init) => app.request(`${ORIGIN}${path}`, init, env),
    dispose: () => miniflare.dispose(),
  };
};
