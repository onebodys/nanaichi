import { fileURLToPath } from "node:url";
import { cloudflare, type WorkerConfig } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

/**
 * 開発サーバーのポート。
 *
 * portless（https://portless.sh/、docs/E2E.md）から起動されたときは、portless が割り振った
 * `PORT` / `HOST` で待ち受ける。portless は `vp` を Vite と見分けられず `--port` を渡さないので、
 * 環境変数をここで読む。認証は `*.localhost` のホストを許可している（src/server/base-url.ts）。
 *
 * それ以外は 5173 に固定する。認証は Host を許可リストと突き合わせるため、
 * ポートがずれるとログインだけが静かに失敗する。別ポートに逃げず落とす。
 */
const devServerOptions = () => {
  const { PORTLESS_URL, PORT, HOST } = process.env;
  if (PORTLESS_URL !== undefined && PORT !== undefined) {
    return { port: Number(PORT), host: HOST ?? "127.0.0.1", strictPort: true };
  }
  return { port: 5173, strictPort: true };
};

/**
 * E2E のときだけ、ユーザーごとのレート制限（wrangler.jsonc の `ratelimits`、ADR 0018）を実質なくす。
 *
 * E2E は同じユーザーで画面を開き直し・操作し続けるので、10 秒 100 回の上限に当たって 429 で落ちる。
 * `e2e.config.ts` が開発サーバーを起動するときに `E2E_RELAX_RATE_LIMIT=enabled` を渡す。
 * 開発サーバー（`serve`）でだけ効かせ、ビルド（デプロイする Worker の設定）には決して入れない。
 * 制限そのものは Workers のテスト（rate-limit.workers.test.ts）で確かめる。
 */
const relaxRateLimitForE2E =
  (command: "build" | "serve") =>
  (config: WorkerConfig): void => {
    if (command !== "serve" || process.env["E2E_RELAX_RATE_LIMIT"] !== "enabled") {
      return;
    }
    // プラグインは返した値を元の設定と配列ごと連結して合成する（defu）ので、返さずに置き換える
    config.ratelimits = config.ratelimits.map((binding) => ({
      ...binding,
      simple: { ...binding.simple, limit: 1_000_000 },
    }));
  };

// lint / fmt の設定はルートの vite.config.ts に集約している（Vite+ の monorepo の仕様）。
export default defineConfig(({ mode, command }) => ({
  plugins: lazyPlugins(() => [
    // テストは Node 上で Hono を直接呼ぶので Worker ランタイムは要らない。
    // better-auth は node:async_hooks などを import するため、Cloudflare プラグインを
    // 入れたまま vitest を走らせると Node 組み込みモジュールの external 指定と衝突する。
    // （Workers ランタイムで動かすテストは vitest.workers.config.ts に分ける）
    ...(mode === "test" ? [] : [cloudflare({ config: relaxRateLimitForE2E(command) })]),
    react(),
    tailwindcss(),
  ]),
  resolve: {
    // shadcn/ui のコンポーネントが使う import エイリアス（tsconfig.app.json の paths と同じ）
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  environments: {
    // 画面は2枚。タイマーの SPA（index.html）と、`/lp` で見せる LP（lp.html、ADR 0024）。
    // Worker の環境にまで入口を足すと Worker のビルドが HTML を読もうとして失敗するので、client の環境にだけ書く
    client: {
      build: {
        rollupOptions: {
          input: {
            index: fileURLToPath(new URL("./index.html", import.meta.url)),
            lp: fileURLToPath(new URL("./lp.html", import.meta.url)),
          },
        },
      },
    },
  },
  server: devServerOptions(),
  // テストは実行環境ごとに設定ファイルを分ける（ルートの vite.config.ts からも同じファイルを指す）
  test: {
    projects: ["./vitest.node.config.ts", "./vitest.workers.config.ts"],
  },
}));
