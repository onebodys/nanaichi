import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import config from "../vite.config.ts";

/**
 * 依存の方向（AGENTS.md §3）の検査を、vite.config.ts の no-restricted-imports の設定そのもので確かめる。
 * 一時ディレクトリに apps/web/src と同じ並びで import だけのファイルを置き、その設定だけを効かせた Oxlint で検査する
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const vp = join(
  dirname(createRequire(import.meta.url).resolve("vite-plus/package.json")),
  "bin/vp",
);

/** vite.config.ts の上書きのうち、no-restricted-imports だけを取り出したもの。ほかのルールは自前のプラグインがないと読めない */
const restrictOverrides = (config.lint?.overrides ?? []).flatMap(({ files, rules }) => {
  const rule = rules?.["no-restricted-imports"];
  return rule === undefined ? [] : [{ files, rules: { "no-restricted-imports": rule } }];
});

type Probe = {
  /** apps/web/src からのパス */
  file: string;
  allowed: string[];
  rejected: string[];
  /** import 文を並べる代わりに、そのまま書くファイルの中身 */
  source?: string;
};

const packages = ["@praha/byethrow", "valibot", "@standard-schema/spec"];

const probes: Record<string, Probe> = {
  "workflows のコードは domain と許したパッケージだけを import できる": {
    file: "workflows/probe.ts",
    allowed: ["./start-session.ts", "../domain/session.ts", ...packages],
    rejected: [
      "better-auth",
      "better-auth/client",
      "@better-auth/core",
      "hono",
      "react",
      "cloudflare:workers",
      "node:fs",
      "../server/user-do.ts",
      "../server/valibot",
      "../client/router.tsx",
      "../device/records.ts",
      "../domain/../server/user-do.ts",
      "@/server/user-do.ts",
      // 許したパッケージのサブパスや、許したパッケージと同じ名前のパス
      "valibot/sub",
      "../valibot",
      "/valibot",
      "../server/@praha/byethrow",
      // 本番のコードからテストのファイルは import しない
      "./start-session.test.ts",
      "./start-session.test",
      "../domain/session.test.js",
      // `*` は `..` にも当たるので、同じディレクトリや domain から親へ戻る書き方
      "./..",
      "../domain/..",
      // サブディレクトリはまだない
      "./sub/x.ts",
      "vite-plus/test",
      "../testing/golden.ts",
      "fake-indexeddb",
      // domain のテストだけに許したもの
      "../../../apple/NanaichiKit/Tests/NanaichiDomainTests/Fixtures/import-batch.json",
    ],
  },
  "workflows のテストはテストの道具も import できる": {
    file: "workflows/probe.test.ts",
    allowed: [
      "./start-session.ts",
      "../domain/session.ts",
      "vite-plus/test",
      "../testing/golden.ts",
    ],
    rejected: [
      "better-auth",
      "fake-indexeddb",
      "../server/user-do.ts",
      "./..",
      "../../../apple/NanaichiKit/Tests/NanaichiDomainTests/Fixtures/import-batch.json",
    ],
  },
  "型だけの import や再 export、動的 import も落とす": {
    file: "workflows/forms.ts",
    allowed: [],
    rejected: ["better-auth", "hono", "react", "better-auth/types", "better-auth/client"],
    source: `import type { Auth } from "better-auth";
export type { Session } from "better-auth/types";
export { Hono } from "hono";
export * from "react";
export const load = () => import("better-auth/client");
`,
  },
  "domain のコードは domain の中と許したパッケージだけを import できる": {
    file: "domain/probe.ts",
    allowed: ["./session.ts", ...packages],
    rejected: [
      "../workflows/start-session.ts",
      "../device/records.ts",
      "../server/user-do.ts",
      "../server/valibot",
      "./session.test.ts",
      "./..",
      "better-auth",
      "vite-plus/test",
      "../testing/golden.ts",
    ],
  },
  "domain のテストは Mac アプリと共有する取り込みの束も import できる": {
    file: "domain/probe.test.ts",
    allowed: [
      "./session.ts",
      "vite-plus/test",
      "../testing/golden.ts",
      "../../../apple/NanaichiKit/Tests/NanaichiDomainTests/Fixtures/import-batch.json",
    ],
    rejected: ["fake-indexeddb", "../workflows/start-session.ts"],
  },
  "device のコードは domain と workflows と許したパッケージだけを import できる": {
    file: "device/probe.ts",
    allowed: ["./records.ts", "../domain/session.ts", "../workflows/start-session.ts", ...packages],
    rejected: [
      "../client/router.tsx",
      "../server/user-do.ts",
      "../server/valibot",
      "../workflows/start-session.test.ts",
      "../workflows/..",
      "react",
      "better-auth",
      "fake-indexeddb",
      "vite-plus/test",
    ],
  },
  "device のテストは fake-indexeddb も import できる": {
    file: "device/probe.test.ts",
    allowed: ["./records.ts", "vite-plus/test", "../testing/store-contract.ts", "fake-indexeddb"],
    rejected: ["../client/router.tsx", "react", "../server/fake-indexeddb", "fake-indexeddb/auto"],
  },
};

const sourceOf = ({ allowed, rejected, source }: Probe) =>
  source ?? [...allowed, ...rejected].map((specifier) => `import "${specifier}";\n`).join("");

/** Oxlint の JSON の出力。ここで使う項目だけを書く */
type LintReport = { diagnostics: { code: string; filename: string; message: string }[] };

/** 設定の誤りなどで JSON が出なかったときは、Oxlint の stderr を添えて落とす */
const parseReport = (stdout: string, stderr: string): LintReport => {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`vp lint の出力が JSON でない\nstdout: ${stdout}\nstderr: ${stderr}`, {
      cause,
    });
  }
};

/** ファイルごとの、落とされた import の一覧 */
const rejectedByFile = new Map<string, string[]>();
let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "nanaichi-lint-"));
  const configPath = join(workDir, ".oxlintrc.json");
  writeFileSync(configPath, JSON.stringify({ overrides: restrictOverrides }));
  const paths = Object.values(probes).map((probe) => {
    const path = join(workDir, "apps/web/src", probe.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, sourceOf(probe));
    return path;
  });
  // vp lint は作業ディレクトリがワークスペースの中でないと動かないので、リポジトリの直下で動かす
  const lint = spawnSync(process.execPath, [vp, "lint", "-c", configPath, "-f", "json", ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (lint.error !== undefined) throw lint.error;
  const report = parseReport(lint.stdout, lint.stderr);
  for (const { code, filename, message } of report.diagnostics) {
    if (code !== "eslint(no-restricted-imports)") continue;
    const specifier = /^'(.+)' import is restricted/.exec(message)?.[1];
    if (specifier === undefined) throw new Error(`読めないメッセージ: ${message}`);
    rejectedByFile.set(filename, [...(rejectedByFile.get(filename) ?? []), specifier]);
  }
}, 30_000);

afterAll(() => {
  if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
});

describe("依存の方向（vite.config.ts の no-restricted-imports）", () => {
  it.each(Object.entries(probes))("%s", (_, probe) => {
    const rejected = rejectedByFile.get(join(workDir, "apps/web/src", probe.file)) ?? [];
    expect(rejected.toSorted()).toEqual(probe.rejected.toSorted());
  });
});
