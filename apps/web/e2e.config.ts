import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";

// E2E テスト（https://e2e.tester.army）の設定。実行方法は docs/E2E.md。
// 対象ブラウザは chromium だけにしている（Issue #15）。
export default {
  tests: "tests/**/*.e2e.ts",
  targets: [
    {
      name: "chromium",
      engine: web({ browser: "chromium", locale: "ja-JP", timezoneId: "Asia/Tokyo" }),
      app: {
        // 認証は Host を許可リスト（src/server/base-url.ts）と突き合わせるため、
        // vite.config.ts と同じ localhost:5173 で開く。
        url: "http://localhost:5173",
        command: {
          executable: "pnpm",
          args: ["exec", "vp", "dev"],
          // 子プロセスには PATH などしか渡らない。`.dev.vars` がなくても認証の設定が読めるよう、
          // ダミーの値をプロセスの環境変数として Worker に渡す。Google には繋がない。
          env: {
            CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
            BETTER_AUTH_SECRET: "e2e-dummy-secret-0123456789abcdef",
            GOOGLE_CLIENT_ID: "e2e-dummy-client-id",
            GOOGLE_CLIENT_SECRET: "e2e-dummy-client-secret",
            ALLOWED_EMAILS: "e2e@example.com,e2e-journal@example.com",
            // Google を通さないテスト用のログイン（/api/test/sign-in）を開く（ADR 0008）。
            // ログインのしかたは tests/sign-in.setup.e2e.ts
            TEST_SIGN_IN: "enabled",
          },
          startupTimeout: 120_000,
          log: ".e2e/logs/app.log",
          // 手元で `pnpm dev` を起動済みならそれを使う（CI では無視される）
          reuseExisting: true,
        },
      },
    },
  ],
} satisfies E2EConfig;
