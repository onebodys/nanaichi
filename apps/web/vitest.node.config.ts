import { defineConfig } from "vite-plus";

/**
 * Node で動かすテスト。ドメイン・ワークフローの純粋な関数と、Hono のルート（auth-test-harness.ts）。
 *
 * Cloudflare の Vite プラグインは入れない。better-auth は node:async_hooks などを import するため、
 * 入れたまま vitest を走らせると Node 組み込みモジュールの external 指定と衝突する。
 */
export default defineConfig({
  test: {
    name: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.workers.test.ts"],
  },
});
