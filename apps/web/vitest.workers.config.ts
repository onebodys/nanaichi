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
      miniflare: {
        // secret は wrangler.jsonc に書かないので、テスト用の値をここで渡す
        bindings: {
          BETTER_AUTH_SECRET: "test-secret-value-that-is-long-enough",
          GOOGLE_CLIENT_ID: "test-google-client-id",
          GOOGLE_CLIENT_SECRET: "test-google-client-secret",
          ALLOWED_EMAILS: "me@example.com,someone@example.com",
          // D1 は空で起動するので、テストの前に本番と同じマイグレーションを当てる（workers-test-harness.ts）
          TEST_MIGRATIONS: await readD1Migrations(`${import.meta.dirname}/migrations`),
        },
        // wrangler.jsonc の assets はディレクトリを Vite のプラグインが渡すので、ここでは ASSETS が付かない。
        // `/` は Worker が ASSETS から画面を引く（ADR 0018）ので、静的アセットがまだない Worker として、どのパスにも 404 を返す
        serviceBindings: {
          ASSETS: () => new Response("Not Found", { status: 404 }),
        },
      },
    })),
  ],
  test: {
    name: "workers",
    include: ["src/**/*.workers.test.ts"],
  },
});
