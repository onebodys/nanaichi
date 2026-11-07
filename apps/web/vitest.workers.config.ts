import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

/**
 * Workers ランタイム（workerd）で動かすテスト（`*.workers.test.ts`）。
 *
 * UserDO（Durable Object）とそれを呼ぶ API は Node では動かせないので、ここで確かめる。
 * Worker は wrangler.jsonc のとおりに起動し、D1 と UserDO は miniflare がローカルに用意する。
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: `${import.meta.dirname}/wrangler.jsonc` },
      // AI バインディング（wrangler.jsonc の `ai`）は本物の Workers AI につながり、呼ぶと上限に数えられる。
      // テストでは決してつながない（ADR 0026）。判断モデルは偽物に差し替えて確かめる
      remoteBindings: false,
      miniflare: {
        // レート制限の窓は実時間の区切りで、テストから動かせない。区切りをまたぐと「使い切ったあとは弾かれる」を
        // 確かめられないので、選べる中で長い 60 秒にする（workers-test-harness.ts の exhaustRateLimit）
        ratelimits: {
          USER_RATE_LIMITER: { namespace_id: "1001", simple: { limit: 100, period: 60 } },
        },
        // secret は wrangler.jsonc に書かないので、テスト用の値をここで渡す
        bindings: {
          BETTER_AUTH_SECRET: "test-secret-value-that-is-long-enough",
          GOOGLE_CLIENT_ID: "test-google-client-id",
          GOOGLE_CLIENT_SECRET: "test-google-client-secret",
          ALLOWED_EMAILS: "me@example.com,someone@example.com",
          // D1 は空で起動するので、テストの前に本番と同じマイグレーションを当てる（workers-test-harness.ts）
          TEST_MIGRATIONS: await readD1Migrations(`${import.meta.dirname}/migrations`),
        },
      },
    })),
  ],
  test: {
    name: "workers",
    include: ["src/**/*.workers.test.ts"],
    // workerd の上で動くのでマシンが混むと既定の 5 秒を超える。
    // 時間の上限は振る舞いの検証ではなく、止まったテストを見つけるためのもの
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
