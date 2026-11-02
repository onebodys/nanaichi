import { defineConfig } from "vite-plus";

type RestrictRule = ["error", { patterns: { group: string[]; message: string }[] }];

const restrict = (group: string[], message: string): RestrictRule => [
  "error",
  { patterns: [{ group, message }] },
];

const web = "apps/web/src";

export default defineConfig({
  // 外部から取り込んだスキル、自動生成ファイル、design-taste-frontend スキルの作業ファイル（.taste-skill/）は検査しない
  fmt: {
    ignorePatterns: [".agents/**", ".claude/**", ".taste-skill/**", "**/worker-configuration.d.ts"],
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
      // 値を返さない switch は型チェックだけでは分岐の抜け漏れに気づけないので、lint で網羅性を検査する（ADR 0014）
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
      {
        files: [`${web}/client/**`],
        rules: {
          "no-restricted-imports": restrict(
            [
              "**/server/**",
              "**/workflows/**",
              "cloudflare:*",
              "**/device",
              "**/device/**",
              "!**/device/index.ts",
            ],
            "client は server / workflows に依存せず、device は device/index.ts だけを import する",
          ),
        },
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
    options: { typeAware: true, typeCheck: true },
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
