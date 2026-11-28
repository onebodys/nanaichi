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

/** domain / workflows / device が共通して使ってよい外部パッケージ */
const packages = [
  // Result 型（AGENTS.md §2）
  "@praha/byethrow",
  // 境界のスキーマ検証（AGENTS.md §4）
  "valibot",
  // schemaResult が受け取る Standard Schema の型（AGENTS.md §4）
  "@standard-schema/spec",
];

/**
 * テストのファイル（*.test.ts）だけで使ってよいもの。
 * domain はブラウザにも配るので、テストの道具がアプリのコードに入らないようにテストだけに許す
 */
const testOnly = [
  "vite-plus/test",
  // ゴールデンケースや記録先の契約など、テストどうしで共有する部品
  "../testing/*",
];

/**
 * domain / workflows / device が import してよいもの（AGENTS.md §3）。ここに並べたもの以外の import は落とす。
 * 足すときはここに足して、理由をコメントに書く。
 * パターンは gitignore の書き方で、`/` を含むパターンの `*` は `/` をまたがない。
 * `./*` は同じディレクトリのファイルだけを指し、`../domain/../server/x.ts` は通らない
 */
const allowedImports = {
  domain: {
    code: ["./*", ...packages],
    test: [
      ...testOnly,
      // Mac アプリの Swift のテストと同じ取り込みの束で、送る形が一致することを確かめる（import.test.ts）
      "../../../apple/NanaichiKit/Tests/NanaichiDomainTests/Fixtures/*",
    ],
    message: "domain は純粋に保つ。外側のディレクトリやフレームワークを import しない",
  },
  workflows: {
    code: ["./*", "../domain/*", ...packages],
    test: testOnly,
    message: "workflows は domain だけに依存する",
  },
  device: {
    code: ["./*", "../domain/*", "../workflows/*", ...packages],
    // IndexedDB を Node のテストで動かす
    test: [...testOnly, "fake-indexeddb"],
    message: "device は domain と workflows だけに依存する",
  },
};

/**
 * 許すものを戻すパターン。`/` を含まないパターン（`valibot`）はどの深さの同じ名前にも当たるので、
 * `!valibot` だけだと `../server/valibot` も戻る。ディレクトリの下にある同じ名前は落とし直す
 */
const allowPattern = (pattern: string): string[] =>
  pattern.includes("/") ? [`!${pattern}`] : [`!${pattern}`, `*/**/${pattern}`];

/**
 * `allowed` に並べたもの以外を落とす。`/` を含まない `*` はすべての import に当たり、`!` で許すものを戻す。
 * `*` は `..` にも当たるので、`./*` や `../domain/*` が戻した `./..`・`../domain/..` は最後に落とし直す。
 * `banned` は、戻したもののうち最後に落とし直すもの
 */
const allowOnly = (
  allowed: readonly string[],
  message: string,
  banned: readonly string[] = [],
): RestrictRule =>
  restrict(
    ["*", ...allowed.flatMap(allowPattern), "**/..", ...banned],
    `${message}（AGENTS.md §3）。使ってよいものは vite.config.ts の allowedImports に並べる`,
  );

// テストのファイルの上書きは前の no-restricted-imports を置き換えるので、アプリのコードに許すものも並べ直す
const allowlistOverrides = Object.entries(allowedImports).flatMap(
  ([dir, { code, test, message }]) => [
    {
      files: [`${web}/${dir}/**`],
      rules: {
        // `./*` や `../domain/*` はテストのファイルも戻すので、本番のコードからテストのファイルを import しないよう落とし直す。
        // 解決は bundler なので、拡張子を省いた `./x.test` や `./x.test.js` も同じファイルを指す
        "no-restricted-imports": allowOnly(code, message, ["*.test", "*.test.*"]),
        // no-restricted-imports が見ない書き方（型の位置の import("x")、文字列リテラルでない動的 import）を止める
        "nanaichi/no-hidden-import": "error" as const,
      },
    },
    {
      files: [`${web}/${dir}/**/*.test.ts`],
      rules: { "no-restricted-imports": allowOnly([...code, ...test], message) },
    },
  ],
);

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
    // nanaichi は AGENTS.md の決まり事のうち、組み込みのルールでは表せないものを検査する自前のプラグイン（lint/nanaichi-plugin.ts）
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "nanaichi", specifier: "./lint/nanaichi-plugin.ts" },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "react/rules-of-hooks": "error",
      "react/only-export-components": ["warn", { allowConstantExport: true }],
      // 値を返さない switch は型チェックだけでは分岐の抜け漏れに気づけないので、lint で網羅性を検査する（ADR 0022）
      "typescript/switch-exhaustiveness-check": "error",
      // 判別可能な union の switch に default を書かない（AGENTS.md §4）。文字列や数値の switch は対象にしない
      "nanaichi/no-default-in-kind-switch": "error",
      // 型アサーション（as）を使わない（AGENTS.md §4）。as const はこのルールの対象外で、as const satisfies も通る
      "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
    },
    // 依存の方向（AGENTS.md「3. Functional Core / Imperative Shell と依存の方向」）を機械的に検査する。
    // domain / workflows / device は許すものを並べ（allowedImports）、server / client は禁止するものを並べる
    overrides: [
      ...allowlistOverrides,
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
      // ここから下は依存の方向ではなく、AGENTS.md のほかの決まり事の検査
      // ドメインでは時刻・乱数・ID を作らない（AGENTS.md §3）。テストはドメインのコードではないので、ID を作ってよい
      {
        files: [`${web}/domain/**`],
        rules: { "nanaichi/no-impure-domain": "error" },
      },
      {
        files: [`${web}/domain/**/*.test.ts`],
        rules: { "nanaichi/no-impure-domain": "off" },
      },
      // 画面は fetch を直接呼ばず、通信層（client/remote-backend.ts）を通す（AGENTS.md §5、ADR 0009）。
      // window.fetch / globalThis.fetch / self.fetch も見る
      {
        files: [`${web}/client/**`],
        rules: {
          "no-restricted-globals": [
            "error",
            {
              globals: [
                {
                  name: "fetch",
                  message:
                    "画面は fetch を直接呼ばない。client/remote-backend.ts の通信層（fetch → スキーマ検証 → Result）を通す",
                },
              ],
              checkGlobalObject: true,
            },
          ],
        },
      },
      // 今は fetch だけなので off にしている。no-restricted-globals にほかを足すときは、ここも見る
      {
        files: [`${web}/client/remote-backend.ts`],
        rules: { "no-restricted-globals": "off" },
      },
    ],
    // 警告が残っていると新しい警告に気づけないので、警告があれば vp check を落とす（Issue #125）
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
  },
  run: {
    cache: true,
  },
  // テストは実行環境ごとの設定ファイル（apps/web は Node と Workers ランタイム）に分けている。
  // lint/ は自前の Oxlint のプラグインのテスト。
  // Vitest は入れ子の projects を展開しないので、ルートからは末端の設定ファイルを直接指す。
  test: {
    projects: ["apps/*/vitest.*.config.ts", "lint/vitest.config.ts", "scripts/vitest.config.ts"],
  },
});
