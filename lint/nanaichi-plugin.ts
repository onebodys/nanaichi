import {
  definePlugin,
  defineRule,
  type ESTree,
  type Scope,
  type SourceCode,
} from "vite-plus/lint/plugins";

/**
 * AGENTS.md の決まり事のうち、Oxlint の組み込みのルールでは表せないものを検査する自前のプラグイン（Issue #113）。
 * どのファイルに効かせるかは vite.config.ts の `lint` で決める。
 */

/**
 * 識別子がファイルの中で宣言されたものを指していないか。`crypto` は ES の組み込みではないので、
 * `isGlobalReference` は環境（env）の設定しだいで偽を返す。宣言を探して、見つからなければグローバルとみなす
 */
const isUndeclared = (identifier: ESTree.Node, name: string, sourceCode: SourceCode): boolean => {
  for (let scope: Scope | null = sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(name);
    if (variable !== undefined && variable.defs.length > 0) return false;
  }
  return true;
};

/** `x.name` と `x["name"]` のどちらでも、メンバーの名前を返す。`x[key]` のように静的に決まらないものは undefined */
const memberName = (node: ESTree.MemberExpression): string | undefined => {
  if (!node.computed) return node.property.name;
  return node.property.type === "Literal" && typeof node.property.value === "string"
    ? node.property.value
    : undefined;
};

/** グローバルを指すオブジェクトの名前。`globalThis.crypto.randomUUID()` も `crypto.randomUUID()` と同じに扱う */
const globalObjects = new Set(["globalThis", "self", "window"]);

/** 式がグローバルの `name` か（`name` そのものか、`globalThis.name`） */
const isGlobal = (node: ESTree.Node, name: string, sourceCode: SourceCode): boolean => {
  if (node.type === "Identifier") return node.name === name && isUndeclared(node, name, sourceCode);
  return (
    node.type === "MemberExpression" &&
    memberName(node) === name &&
    node.object.type === "Identifier" &&
    globalObjects.has(node.object.name) &&
    isUndeclared(node.object, node.object.name, sourceCode)
  );
};

/** `Date.now()` のように、グローバルの `object` の `property` を読む式か */
const isGlobalMember = (
  node: ESTree.Node,
  object: string,
  property: string,
  sourceCode: SourceCode,
): boolean =>
  node.type === "MemberExpression" &&
  memberName(node) === property &&
  isGlobal(node.object, object, sourceCode);

/** ドメインで呼ばない、時刻・乱数・ID を作る関数（`new Date()` は別に見る） */
const impureCalls = [
  { object: "Date", property: "now", instead: "時刻は引数で受け取る" },
  { object: "Math", property: "random", instead: "乱数は引数で受け取る" },
  { object: "crypto", property: "randomUUID", instead: "ID は引数で受け取る" },
] as const;

const noImpureDomain = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "ドメインでは時刻・乱数・ID を作らない（Date.now() / 引数なしの new Date() / crypto.randomUUID() / Math.random()）",
    },
  },
  create: (context) => ({
    CallExpression: (node) => {
      const call = impureCalls.find(({ object, property }) =>
        isGlobalMember(node.callee, object, property, context.sourceCode),
      );
      if (call === undefined) return;
      context.report({
        node,
        message: `ドメインは純粋に保つ。${call.object}.${call.property}() を呼ばず、${call.instead}（AGENTS.md §3）`,
      });
    },
    NewExpression: (node) => {
      if (node.arguments.length === 0 && isGlobal(node.callee, "Date", context.sourceCode)) {
        context.report({
          node,
          message:
            "ドメインは純粋に保つ。引数なしの new Date() で今の時刻を作らず、時刻は引数で受け取る（AGENTS.md §3）",
        });
      }
    },
  }),
});

/** `switch (state.kind)` や `switch (kind)` のように、判別子 `kind` で分けている switch か */
const switchesOnKind = (discriminant: ESTree.Expression): boolean => {
  if (discriminant.type === "Identifier") return discriminant.name === "kind";
  if (discriminant.type === "ChainExpression" || discriminant.type === "TSNonNullExpression") {
    return switchesOnKind(discriminant.expression);
  }
  return discriminant.type === "MemberExpression" && memberName(discriminant) === "kind";
};

/**
 * 判別可能な union の switch か。JS のプラグインには型の情報がないので、形で見分ける。
 * 自分で定義する型の判別子は必ず `kind` で、値は文字列（AGENTS.md §2）。`kind` で分けていて、
 * 文字列でないリテラルの case（`case 0:` など）がないものを判別可能な union の switch とみなす。
 * `case CIRCLE:` のような定数は値を辿れないので、判別可能な union の switch のほうに数える
 */
const isDiscriminatedUnionSwitch = (node: ESTree.SwitchStatement): boolean =>
  switchesOnKind(node.discriminant) &&
  node.cases.every(
    ({ test }) => test === null || test.type !== "Literal" || typeof test.value === "string",
  );

const noDefaultInKindSwitch = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "判別可能な union の switch（判別子 kind で分ける switch）に default を書かない。文字列や数値の switch は対象外",
    },
  },
  create: (context) => ({
    SwitchStatement: (node) => {
      if (!isDiscriminatedUnionSwitch(node)) return;
      const fallback = node.cases.find((switchCase) => switchCase.test === null);
      if (fallback === undefined) return;
      context.report({
        node: fallback,
        message:
          "判別可能な union の switch に default を書かない。すべての kind を case に並べ、同じ扱いのものは case を続けて書く（AGENTS.md §4、ADR 0022）",
      });
    },
  }),
});

export default definePlugin({
  meta: { name: "nanaichi" },
  rules: {
    "no-impure-domain": noImpureDomain,
    "no-default-in-kind-switch": noDefaultInKindSwitch,
  },
});
