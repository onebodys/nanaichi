import type { KnipConfig } from "knip";

// Vite+ プラグイン（https://knip.dev/reference/plugins/vite-plus）は vite-plus が依存にあれば自動で有効になり、
// 各ワークスペースの vite.config.ts を読む。ここには誤検知の除外だけを書く。
export default {
  // 外部から取り込んだスキル（skills-lock.json で管理）。サンプルコードはどこからも import されない
  ignore: [".agents/**"],
  workspaces: {
    ".": {
      // `vite` は vite-plus-core の別名（pnpm-workspace.yaml の catalog / overrides）。
      // コードからは import しないが、Vite+ が `vite` として解決できるようにルートにも置く
      ignoreDependencies: ["vite"],
    },
    "apps/web": {
      // E2E ランナー（e2e、docs/E2E.md）には knip のプラグインがないので、設定とテストを入口として教える
      // Service Worker（public/sw.js）は import されず、画面が URL で登録する（client/phase-notification.ts）
      // LP（landing.html）の入口は vite.config.ts の environments.client にあり、Vite+ プラグインが読まないので教える（ADR 0018）
      // この端末の記録先（device/index.ts）は、画面がまだ読み込んでいない。router から動的 import するまで入口として教える（Issue #85）
      entry: [
        "e2e.config.ts",
        "tests/**/*.e2e.ts",
        "public/sw.js",
        "src/client/landing/main.ts",
        "src/device/index.ts",
      ],
      // `cloudflare:workers` は Workers ランタイムの組み込みモジュールで、npm パッケージではない
      ignoreDependencies: ["cloudflare"],
      // portless は公式の方針どおりプロジェクトの依存にせずグローバルに入れる（`dev:portless`、docs/E2E.md）
      ignoreBinaries: ["portless"],
    },
  },
} satisfies KnipConfig;
