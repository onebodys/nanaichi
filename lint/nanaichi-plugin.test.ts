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

tester.run("no-impure-domain", rule("no-impure-domain"), {
  valid: [
    "const at = (iso: string) => new Date(iso);",
    "const copy = (time: Date) => new Date(time.getTime());",
    "const floor = (n: number) => Math.floor(n);",
    "const parse = (iso: string) => Date.parse(iso);",
    // 引数で受け取った時計や ID の発行は使ってよい
    "const stamp = (clock: { now: () => number }) => clock.now();",
    // ファイルの中で宣言したものはグローバルではない
    "const Date = { now: () => 0 }; const t = Date.now();",
    "const read = (crypto: { randomUUID: () => string }) => crypto.randomUUID();",
  ],
  invalid: [
    {
      code: "const now = () => Date.now();",
      errors: [{ message: /Date\.now\(\) を呼ばず、時刻は引数で受け取る/ }],
    },
    {
      code: "const now = () => new Date();",
      errors: [{ message: /引数なしの new Date\(\)/ }],
    },
    {
      code: "const id = () => crypto.randomUUID();",
      errors: [{ message: /crypto\.randomUUID\(\) を呼ばず、ID は引数で受け取る/ }],
    },
    {
      code: "const id = () => globalThis.crypto.randomUUID();",
      errors: [{ message: /crypto\.randomUUID\(\)/ }],
    },
    {
      code: "const dice = () => Math.random();",
      errors: [{ message: /Math\.random\(\) を呼ばず、乱数は引数で受け取る/ }],
    },
  ],
});

const shape = `type Shape = { kind: "Circle"; r: number } | { kind: "Square"; a: number };`;

tester.run("no-default-in-kind-switch", rule("no-default-in-kind-switch"), {
  valid: [
    `${shape}
const area = (shape: Shape) => {
  switch (shape.kind) {
    case "Circle":
      return shape.r;
    case "Square":
      return shape.a;
  }
};`,
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
      code: `${shape}
const area = (shape: Shape) => {
  switch (shape.kind) {
    case "Circle":
      return shape.r;
    default:
      return 0;
  }
};`,
      errors: [{ message: /判別可能な union の switch に default を書かない/, line: 6 }],
    },
    {
      code: `${shape}
const area = ({ kind }: Shape) => {
  switch (kind) {
    default:
      return 0;
  }
};`,
      errors: 1,
    },
    {
      code: `${shape}
const area = (shape?: Shape) => {
  switch (shape?.kind) {
    default:
      return 0;
  }
};`,
      errors: 1,
    },
    {
      code: `${shape}
const area = (shape: Shape) => {
  switch (shape["kind"]) {
    default:
      return 0;
  }
};`,
      errors: 1,
    },
  ],
});
