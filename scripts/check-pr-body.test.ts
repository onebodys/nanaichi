import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const script = new URL("check-pr-body.sh", import.meta.url).pathname;
const template = new URL("../.github/pull_request_template.md", import.meta.url);

/** テンプレートの「## 」の行。スクリプトと同じく、これを必須の見出しとして使う */
const headings = readFileSync(template, "utf8")
  .split("\n")
  .filter((line) => line.startsWith("## "))
  .map((line) => line.slice(3).trim());

const check = (body: string) => {
  const result = spawnSync("sh", [script], { input: body, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
};

const sections = (fill: (heading: string) => string) =>
  headings.map((heading) => `## ${heading}\n\n${fill(heading)}\n`).join("\n");

const complete = `Closes #115\n\n${sections(() => "書いた")}`;

describe("PR の本文の検査", () => {
  test("テンプレートには必須の見出しが4つある", () => {
    expect(headings).toHaveLength(4);
  });

  test("4つの見出しに本文があり Closes #N があれば通る", () => {
    expect(check(complete)).toEqual({ status: 0, stderr: "" });
  });

  test("CRLF の本文、深さの違う見出し、行末の空白も通る", () => {
    const body = complete.replace("## ", "### ").replaceAll("\n", "  \r\n");
    expect(check(body).status).toBe(0);
  });

  test("見出しの下に小見出しとその本文だけがあっても通る", () => {
    const body = `Closes #1\n\n${sections((heading) => `### ${heading}の細目\n\n書いた`)}`;
    expect(check(body).status).toBe(0);
  });

  test("見出しが欠けていれば、欠けた見出しを出して落ちる", () => {
    const [first = "", ...rest] = headings;
    const body = complete.replace(`## ${first}\n`, "");
    const result = check(body);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`見出し「${first}」`);
    for (const heading of rest) expect(result.stderr).not.toContain(`見出し「${heading}」`);
  });

  test("# のあとに空白のない行は見出しとして数えない", () => {
    const [first = ""] = headings;
    const result = check(complete.replace(`## ${first}`, `##${first}`));
    expect(result.stderr).toContain(`見出し「${first}」`);
  });

  test("空のセクションがあれば落ちる", () => {
    const [first = ""] = headings;
    const body = complete.replace(`## ${first}\n\n書いた`, `## ${first}\n\n`);
    const result = check(body);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`見出し「${first}」の下の本文`);
  });

  test("HTML コメントだけのセクションは空として落ちる", () => {
    const [first = ""] = headings;
    const body = complete.replace(
      `## ${first}\n\n書いた`,
      `## ${first}\n\n<!-- ここに書く -->\n<!--\n複数行のコメント\n-->\n`,
    );
    expect(check(body).stderr).toContain(`見出し「${first}」の下の本文`);
  });

  test("Closes #N がなければ落ちる", () => {
    const result = check(complete.replace("Closes #115", ""));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Closes #<Issue の番号>");
  });

  test.each([
    ["番号のない Closes #", "Closes #"],
    ["0 で始まる番号", "Closes #0"],
    ["番号のあとに英数字が続くもの", "Closes #123abc"],
    ["コードブロックの中", "```\nCloses #115\n```"],
    ["~~~ のコードブロックの中", "~~~md\nCloses #115\n~~~"],
    ["HTML コメントの中", "<!-- Closes #115 -->"],
    ["行をまたぐ HTML コメントの中", "<!--\nCloses #115\n-->"],
    ["インラインコードの中", "`Closes #115`"],
    ["ほかの語の一部", "Encloses #115"],
  ])("%s の Closes は数えない", (_, closes) => {
    const result = check(complete.replace("Closes #115", closes));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Closes #<Issue の番号>");
  });

  test.each([
    ["小文字", "closes #115"],
    ["コロンつき", "Closes: #115"],
    ["文の途中", "これで Closes #115。"],
  ])("%s の Closes は数える", (_, closes) => {
    expect(check(complete.replace("Closes #115", closes)).status).toBe(0);
  });

  test("コードブロックの中の見出しは数えない", () => {
    const [first = ""] = headings;
    const body = complete.replace(`## ${first}\n\n書いた`, `\`\`\`\n## ${first}\n書いた\n\`\`\``);
    expect(check(body).stderr).toContain(`見出し「${first}」`);
  });
});
