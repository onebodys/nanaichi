import { defineConfig } from "vite-plus";

type RestrictRule = [
  "error",
  { patterns: { group: string[]; importNames?: string[]; message: string }[] },
];

const restrict = (group: string[], message: string): RestrictRule => [
  "error",
  { patterns: [{ group, message }] },
];

const web = "apps/web/src";

const clientBannedImports = [
  "**/server/**",
  "**/workflows/**",
  "cloudflare:*",
  "**/device",
  "**/device/**",
  "!**/device/index.ts",
];
const clientBannedMessage =
  "client は server / workflows に依存せず、device は device/index.ts だけを import する";

const recordStoreReaders = ["app-header.tsx", "settings-screen.tsx", "router.tsx"];

export default defineConfig({
  // 外部から取り込んだスキル、自動生成ファイル、design-taste-frontend スキルの作業ファイル（.taste-skill/）は検査しない
  fmt: {
    // fixtures/golden はテストが書き出す生成物で、整形し直すと内容の一致検査が落ちる
    ignorePatterns: [
      ".agents/**",
      ".claude/**",
      ".taste-skill/**",
      "**/worker-configuration.d.ts",
      "fixtures/golden/**",
    ],
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    ignorePatterns: [".agents/**", ".claude/**", ".taste-skill/**", "**/worker-configuration.d.ts"],
    plugins: ["unicorn", "typescript", "oxc", "react"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "react/rules-of-hooks": "error",
      "react/only-export-components": ["warn", { allowConstantExport: true }],
      // 値を返さない switch は型チェックだけでは分岐の抜け漏れに気づけないので、lint で網羅性を検査する（ADR 0022）
      "typescript/switch-exhaustiveness-check": "error",
    },
    // 依存の方向（AGENTS.md「3. Functional Core / Imperative Shell と依存の方向」）を機械的に検査する。
    overrides: [
      {
        files: [`${web}/domain/**`],
        rules: {
          "no-restricted-imports": restrict(
            [
              "**/workflows/**",
              "**/server/**",
              "**/client/**",
              "**/device",
              "**/device/**",
              "hono",
              "hono/*",
              "react",
              "react-dom",
              "react-dom/*",
              "cloudflare:*",
              "better-auth",
              "better-auth/*",
            ],
            "domain は純粋に保つ。外側のディレクトリやフレームワークを import しない",
          ),
        },
      },
      {
        files: [`${web}/workflows/**`],
        rules: {
          "no-restricted-imports": restrict(
            [
              "**/server/**",
              "**/client/**",
              "**/device",
              "**/device/**",
              "hono",
              "hono/*",
              "react",
              "react-dom",
              "react-dom/*",
              "cloudflare:*",
            ],
            "workflows は domain だけに依存する",
          ),
        },
      },
      {
        files: [`${web}/server/**`],
        rules: {
          "no-restricted-imports": restrict(
            ["**/client/**", "**/device", "**/device/**", "react", "react-dom", "react-dom/*"],
            "server は client / device に依存しない",
          ),
        },
      },
      // `paths` は `./record-store.ts` や `@/client/record-store` を見逃すので `patterns` で書く。
      // 後の `files` の上書きは前の no-restricted-imports を置き換えるので、client の禁止は各ブロックで繰り返す
      {
        files: [`${web}/client/**`],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                { group: clientBannedImports, message: clientBannedMessage },
                {
                  group: ["**/record-store", "**/record-store.ts"],
                  importNames: ["useRecordStore"],
                  message:
                    "useRecordStore を読んでよいのは app-header.tsx / settings-screen.tsx / router.tsx だけ。データを読み書きする側は記録先で分岐せず Backend だけを見る",
                },
              ],
            },
          ],
        },
      },
      {
        files: recordStoreReaders.map((file) => `${web}/client/${file}`),
        rules: { "no-restricted-imports": restrict(clientBannedImports, clientBannedMessage) },
      },
      {
        files: [`${web}/device/**`],
        rules: {
          "no-restricted-imports": restrict(
            [
              "**/client",
              "**/client/**",
              "**/server",
              "**/server/**",
              "hono",
              "hono/*",
              "react",
              "react-dom",
              "react-dom/*",
              "cloudflare:*",
              "better-auth",
              "better-auth/*",
            ],
            "device は domain と workflows だけに依存する",
          ),
        },
      },
    ],
    // 警告が残っていると新しい警告に気づけないので、警告があれば vp check を落とす（Issue #125）
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
  },
  run: {
    cache: true,
  },
  // テストは実行環境ごとの設定ファイル（apps/web は Node と Workers ランタイム）に分けている。
  // Vitest は入れ子の projects を展開しないので、ルートからは末端の設定ファイルを直接指す。
  test: {
    projects: ["apps/*/vitest.*.config.ts"],
  },
});
