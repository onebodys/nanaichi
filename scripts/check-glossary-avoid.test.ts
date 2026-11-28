import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";

const script = fileURLToPath(new URL("check-glossary-avoid.sh", import.meta.url));

// このファイルもリポジトリの検査の対象なので、GLOSSARY.md の太字の語は組み立てて書く
const aiJudge = ["AI", "判定"].join(" ");
const pomodoro = ["ポモ", "ドーロ"].join("");

const glossary = [
  "# 用語",
  "",
  "**ほげ (Hoge)**:",
  "説明。",
  "_Avoid_: **ふが語**、紛れる語、**ぴよ語**（紛らわしい）",
  "",
  "**ほげほげ (HogeHoge)**:",
  `_Avoid_: **${aiJudge}**、**${pomodoro}**`,
  "",
  "**太字は Avoid の行だけ (Other)**:",
  "**本文の太字**は語として拾わない。",
].join("\n");

let repo = "";

/**
 * push 時のフックの中では GIT_DIR などが入っていて、そのままだと一時ディレクトリでの git init や git grep が
 * このリポジトリを指してしまう（git init は core.bare を書き換える）。GIT_ で始まる環境変数は渡さない
 */
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

/** 一時 git リポジトリに GLOSSARY.md とスクリプトとファイルを置いてコミットの対象にし、検査を走らせる */
const check = (files: Record<string, string>, glossaryText = glossary) => {
  repo = mkdtempSync(join(tmpdir(), "check-glossary-avoid-"));
  const all = { "GLOSSARY.md": glossaryText, ...files };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  mkdirSync(join(repo, "scripts"));
  copyFileSync(script, join(repo, "scripts/check-glossary-avoid.sh"));
  spawnSync("git", ["init", "-q"], { cwd: repo, env });
  spawnSync("git", ["add", "-A"], { cwd: repo, env });
  const result = spawnSync("sh", [join(repo, "scripts/check-glossary-avoid.sh")], {
    encoding: "utf8",
    env,
  });
  return { status: result.status, stderr: result.stderr };
};

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("GLOSSARY の言い換えの検査", () => {
  test("太字の語がなければ通る", () => {
    expect(check({ "docs/a.md": "ほげを使う。" })).toEqual({ status: 0, stderr: "" });
  });

  test("太字の語を書くと、ファイルと行を出して落ちる", () => {
    const result = check({ "apps/web/src/a.ts": "const a = 1;\n// ふが語を出す\n" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apps/web/src/a.ts:2:// ふが語を出す");
  });

  test("括弧の注釈がついた太字の語も検査する", () => {
    expect(check({ "README.md": "ぴよ語" }).status).toBe(1);
  });

  test("空白を含む太字の語は、空白のありなしどちらでも当たる", () => {
    expect(check({ "docs/a.md": `${aiJudge}で決める` }).status).toBe(1);
    expect(check({ "docs/a.md": `${aiJudge.replace(" ", "")}で決める` }).status).toBe(1);
  });

  test("太字でない語と、Avoid の行の外の太字は検査しない", () => {
    expect(check({ "docs/a.md": "紛れる語と本文の太字と太字は Avoid の行だけ" }).status).toBe(0);
  });

  test.each([
    ["ADR", "docs/adr/0001-a.md"],
    ["外から取り込んだスキル", ".agents/skills/kamae/SKILL.md"],
  ])("%s は検査しない", (_, path) => {
    expect(check({ [path]: "ふが語" }).status).toBe(0);
  });

  test("このプロジェクトのスキルは検査する", () => {
    expect(check({ ".agents/skills/mutation-test/SKILL.md": "ふが語" }).status).toBe(1);
  });

  test("手法とタイマーの名前の言い回しは除くが、ほかの使い方は当たる", () => {
    const allowed = [`${pomodoro}・テクニック`, `${pomodoro}テクニック`, `${pomodoro}タイマー`];
    expect(check({ "docs/a.md": allowed.join("、") }).status).toBe(0);
    expect(check({ "docs/a.md": `${allowed[0]}の1${pomodoro}` }).status).toBe(1);
  });

  test("コミットの対象でないファイルは検査しない", () => {
    expect(check({ ".gitignore": "ignored.md\n", "ignored.md": "ふが語" }).status).toBe(0);
  });

  test("Avoid に太字の語がなければ、書き方が変わったとして落ちる", () => {
    const result = check({}, "_Avoid_: ふが語、****、ぴよ語\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("太字の語が見つかりません");
  });
});
