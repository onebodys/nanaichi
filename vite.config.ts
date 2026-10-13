import { defineConfig } from "vite-plus";

type RestrictRule = ["error", { patterns: { group: string[]; message: string }[] }];

const restrict = (group: string[], message: string): RestrictRule => [
  "error",
  { patterns: [{ group, message }] },
];

const web = "apps/web/src";

export default defineConfig({
  // 外部から取り込んだスキルと自動生成ファイルは検査しない
  fmt: {
    ignorePatterns: [".agents/**", ".claude/**", "**/worker-configuration.d.ts"],
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    ignorePatterns: [".agents/**", ".claude/**", "**/worker-configuration.d.ts"],
    plugins: ["unicorn", "typescript", "oxc", "react"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "react/rules-of-hooks": "error",
      "react/only-export-components": ["warn", { allowConstantExport: true }],
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
            ["**/client/**", "react", "react-dom", "react-dom/*"],
            "server は client に依存しない",
          ),
        },
      },
      {
        files: [`${web}/client/**`],
        rules: {
          "no-restricted-imports": restrict(
            ["**/server/**", "**/workflows/**", "cloudflare:*"],
            "client は server / workflows に依存しない",
          ),
        },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
