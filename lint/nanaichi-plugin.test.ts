import { RuleTester } from "vite-plus/lint/plugins-dev";
import { describe, it } from "vite-plus/test";
import plugin from "./nanaichi-plugin.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const rule = (name: string) => {
  const found = plugin.rules[name];
  if (found === undefined) throw new Error(`ルール ${name} がない`);
  return found;
};

/** 1つのコードで、メッセージが1件出る invalid のケース */
const reported = (code: string, message: RegExp) => ({ code, errors: [{ message }] });

const dateNow = /Date\.now を使わず、時刻は引数で受け取る/;
const mathRandom = /Math\.random を使わず、乱数は引数で受け取る/;
const randomUUID = /crypto\.randomUUID を使わず、ID は引数で受け取る/;
const newDate = /引数なしの new Date\(\) で今の時刻を作らず/;
const callDate = /Date\(\) で今の時刻を作らず/;

tester.run("no-impure-domain", rule("no-impure-domain"), {
  valid: [
    "const at = (iso: string) => new Date(iso);",
    "const copy = (time: Date) => new Date(time.getTime());",
    "const at = (ms: number) => new globalThis.Date(ms);",
    "const floor = (n: number) => Math.floor(n);",
    "const parse = (iso: string) => Date.parse(iso);",
    "const { parse, UTC } = Date;",
    "const read = (key: string) => Date[key];",
    // 引数で受け取った時計や ID の発行は使ってよい
    "const stamp = (clock: { now: () => number }) => clock.now();",
    "const { now } = clock;",
    // ファイルの中で値として宣言したものはグローバルではない
    "const Date = { now: () => 0 }; const t = Date.now();",
    "const read = (crypto: { randomUUID: () => string }) => crypto.randomUUID();",
    "const globalThis = { crypto: { randomUUID: () => 'x' } }; const id = globalThis.crypto.randomUUID();",
    "const window = { Date: { now: () => 0 } }; const t = window.Date.now();",
  ],
  invalid: [
    reported("const now = () => Date.now();", dateNow),
    reported("const dice = () => Math.random();", mathRandom),
    reported("const id = () => crypto.randomUUID();", randomUUID),
    reported("const now = () => new Date();", newDate),
    reported("const now = () => new globalThis.Date();", newDate),
    // new なしの Date() は、引数があっても今の時刻の文字列を返す
    reported("const now = () => Date();", callDate),
    reported("const now = () => Date(0);", callDate),
    // グローバルのオブジェクトを通して
    reported("const id = () => globalThis.crypto.randomUUID();", randomUUID),
    reported("const id = () => self.crypto.randomUUID();", randomUUID),
    reported("const now = () => window.Date.now();", dateNow),
    // 文字列のキー
    reported('const now = () => Date["now"]();', dateNow),
    reported("const now = () => Date[`now`]();", dateNow),
    reported('const now = () => globalThis["Date"].now();', dateNow),
    reported('const dice = () => Math["random"]();', mathRandom),
    reported('const id = () => crypto["randomUUID"]();', randomUUID),
    // オプショナルチェーン
    reported("const now = () => Date?.now();", dateNow),
    reported("const now = () => (Date?.now)();", dateNow),
    // 呼ばずに参照する
    reported("const stamp = (now = Date.now) => now();", dateNow),
    reported("const now = Date.now;", dateNow),
    reported("const now = () => Date.now.call(Date);", dateNow),
    // 分割代入で取り出す
    reported("const { now } = Date;", dateNow),
    reported("const { random: dice } = Math;", mathRandom),
    reported("let now; ({ now } = Date);", dateNow),
    reported("const stamp = ({ now } = Date) => now();", dateNow),
    // 型だけの宣言は、グローバルの値を隠さない
    reported("type Date = number; const now = () => Date.now();", dateNow),
    reported("interface Date { x: number } const now = () => Date.now();", dateNow),
    reported('import type { Date } from "./date.ts"; const now = () => Date.now();', dateNow),
    reported('import { type Date } from "./date.ts"; const now = () => Date.now();', dateNow),
  ],
});

const shape = `type Shape = { kind: "Circle"; r: number } | { kind: "Square"; a: number };`;

/** `shape` を `discriminant` で分ける switch。`cases` は case と default の並び */
const area = (discriminant: string, cases: string) => `${shape}
const area = (shape: Shape) => {
  switch (${discriminant}) {
${cases}
  }
};`;

const kindError = { message: /判別可能な union の switch に default を書かない/ };

tester.run("no-default-in-kind-switch", rule("no-default-in-kind-switch"), {
  valid: [
    area(
      "shape.kind",
      `    case "Circle":
      return shape.r;
    case "Square":
      return shape.a;`,
    ),
    // 文字列や数値の switch は対象にしない
    `const label = (name: string) => {
  switch (name) {
    case "a":
      return "A";
    default:
      return "?";
  }
};`,
    `const sign = (n: number) => {
  switch (n) {
    case 0:
      return "zero";
    default:
      return "other";
  }
};`,
    // kind という名前でも、文字列でないリテラルで分ける switch は判別可能な union の switch ではない
    ...["0", "-1", "+1", "true", "null"].map(
      (value) => `const level = (kind: unknown) => {
  switch (kind) {
    case ${value}:
      return "match";
    default:
      return "other";
  }
};`,
    ),
    // byethrow の Result の判別子 type はライブラリの都合で、自分で定義する判別子ではない
    `const show = (result: { type: "Success" } | { type: "Failure" }) => {
  switch (result.type) {
    case "Success":
      return "ok";
    default:
      return "ng";
  }
};`,
  ],
  invalid: [
    {
      code: area(
        "shape.kind",
        `    case "Circle":
      return shape.r;
    default:
      return 0;`,
      ),
      errors: [{ ...kindError, line: 6 }],
    },
    // すべての kind を並べていても、default は書かない
    {
      code: area(
        "shape.kind",
        `    case "Circle":
      return shape.r;
    case "Square":
      return shape.a;
    default:
      return 0;`,
      ),
      errors: [kindError],
    },
    // 定数の case でも見る
    {
      code: `const CIRCLE = "Circle";
${area(
  "shape.kind",
  `    case CIRCLE:
      return 1;
    default:
      return 0;`,
)}`,
      errors: [kindError],
    },
    // 判別子の書き方を変えても見る
    ...[
      "shape?.kind",
      'shape["kind"]',
      "shape!.kind",
      "shape.kind satisfies string",
      "(shape.kind)",
    ].map((discriminant) => ({
      code: area(
        discriminant,
        `    default:
      return 0;`,
      ),
      errors: [kindError],
    })),
    {
      code: `${shape}
const area = ({ kind }: Shape) => {
  switch (kind) {
    default:
      return 0;
  }
};`,
      errors: [kindError],
    },
  ],
});
