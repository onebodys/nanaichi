import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

// lint / fmt の設定はルートの vite.config.ts に集約している（Vite+ の monorepo の仕様）。
export default defineConfig(({ mode }) => ({
  plugins: lazyPlugins(() => [
    // テストは Node 上で Hono を直接呼ぶので Worker ランタイムは要らない。
    // better-auth は node:async_hooks などを import するため、Cloudflare プラグインを
    // 入れたまま vitest を走らせると Node 組み込みモジュールの external 指定と衝突する。
    // （`cloudflare:workers` を import するモジュールをテストするときは必要になる）
    ...(mode === "test" ? [] : [cloudflare()]),
    react(),
    tailwindcss(),
  ]),
  server: {
    // 認証は Host を許可リスト（src/server/base-url.ts）と突き合わせるため、
    // ポートがずれるとログインだけが静かに失敗する。別ポートに逃げず落とす。
    port: 5173,
    strictPort: true,
  },
}));
