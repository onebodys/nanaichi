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

/** `(x?.y)`・`x!`・`x satisfies T` の包みを剥がした、中の式 */
const unwrap = (node: ESTree.Node): ESTree.Node =>
  node.type === "ChainExpression" ||
  node.type === "ParenthesizedExpression" ||
  node.type === "TSNonNullExpression" ||
  node.type === "TSSatisfiesExpression"
    ? unwrap(node.expression)
    : node;

/** 型だけの宣言（`type Date = ...`・`interface Date {}`・`import type { Date }`）か。値の名前を隠さない */
const isTypeOnlyDefinition = ({ node, parent }: Scope["variables"][number]["defs"][number]) =>
  node.type === "TSTypeAliasDeclaration" ||
  node.type === "TSInterfaceDeclaration" ||
  (node.type === "ImportSpecifier" && node.importKind === "type") ||
  (parent?.type === "ImportDeclaration" && parent.importKind === "type");

/**
 * 識別子がファイルの中で値として宣言されたものを指していないか。`crypto` は ES の組み込みではないので、
 * `isGlobalReference` は環境（env）の設定しだいで偽を返す。値の宣言を探して、見つからなければグローバルとみなす
 */
const isUndeclared = (identifier: ESTree.Node, name: string, sourceCode: SourceCode): boolean => {
  for (let scope: Scope | null = sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(name);
    if (variable?.defs.some((def) => !isTypeOnlyDefinition(def))) return false;
  }
  return true;
};

/** `x.name`・`x["name"]`・``x[`name`]`` のどれでも、メンバーやプロパティのキーの名前を返す。静的に決まらないものは undefined */
const keyName = (key: ESTree.Node, computed: boolean): string | undefined => {
  // 分割代入の `{ "now": now }` は computed でない文字列のキーになる
  if (key.type === "Literal") return typeof key.value === "string" ? key.value : undefined;
  if (!computed) return key.type === "Identifier" ? key.name : undefined;
  if (key.type === "TemplateLiteral" && key.expressions.length === 0) {
    return key.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

const memberName = (node: ESTree.MemberExpression): string | undefined =>
  keyName(node.property, node.computed);

/** グローバルを指すオブジェクトの名前。`globalThis.crypto.randomUUID()` も `crypto.randomUUID()` と同じに扱う */
const globalObjects = new Set(["globalThis", "self", "window"]);

/** 式がグローバルの `name` か（`name` そのものか、`globalThis.name`） */
const isGlobal = (expression: ESTree.Node, name: string, sourceCode: SourceCode): boolean => {
  const node = unwrap(expression);
  if (node.type === "Identifier") return node.name === name && isUndeclared(node, name, sourceCode);
  if (node.type !== "MemberExpression" || memberName(node) !== name) return false;
  const object = unwrap(node.object);
  return (
    object.type === "Identifier" &&
    globalObjects.has(object.name) &&
    isUndeclared(object, object.name, sourceCode)
  );
};

/** ドメインで使わない、時刻・乱数・ID を作る関数（`Date()` と `new Date()` は別に見る） */
const impureMembers = [
  { object: "Date", property: "now", instead: "時刻は引数で受け取る" },
  { object: "Math", property: "random", instead: "乱数は引数で受け取る" },
  { object: "crypto", property: "randomUUID", instead: "ID は引数で受け取る" },
] as const;

type ImpureMember = (typeof impureMembers)[number];

const impureMessage = ({ object, property, instead }: ImpureMember) =>
  `ドメインは純粋に保つ。${object}.${property} を使わず、${instead}（AGENTS.md §3）`;

/** `const { now } = Date` のような分割代入で取り出している、ドメインで使わない関数 */
const destructuredImpure = (
  pattern: ESTree.Node,
  value: ESTree.Node | null | undefined,
  sourceCode: SourceCode,
): ImpureMember[] => {
  if (pattern.type !== "ObjectPattern" || value == null) return [];
  const names = pattern.properties.flatMap((property) => {
    if (property.type !== "Property") return [];
    const name = keyName(property.key, property.computed);
    return name === undefined ? [] : [name];
  });
  return impureMembers.filter(
    ({ object, property }) => names.includes(property) && isGlobal(value, object, sourceCode),
  );
};

const noImpureDomain = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "ドメインでは時刻・乱数・ID を作らない（Date.now / Date() / 引数なしの new Date() / crypto.randomUUID / Math.random）",
    },
  },
  create: (context) => {
    const { sourceCode } = context;
    const reportDestructured = (pattern: ESTree.Node, value: ESTree.Node | null | undefined) => {
      for (const member of destructuredImpure(pattern, value, sourceCode)) {
        context.report({ node: pattern, message: impureMessage(member) });
      }
    };
    return {
      // 呼び出しだけでなく、`= Date.now` や `Date.now.call(Date)` のような参照も止める
      MemberExpression: (node) => {
        const member = impureMembers.find(({ object, property }) =>
          memberName(node) === property ? isGlobal(node.object, object, sourceCode) : false,
        );
        if (member !== undefined) context.report({ node, message: impureMessage(member) });
      },
      VariableDeclarator: (node) => reportDestructured(node.id, node.init),
      AssignmentExpression: (node) => reportDestructured(node.left, node.right),
      AssignmentPattern: (node) => reportDestructured(node.left, node.right),
      // `new` なしの `Date()` は、引数があってもなくても今の時刻の文字列を返す
      CallExpression: (node) => {
        if (!isGlobal(node.callee, "Date", sourceCode)) return;
        context.report({
          node,
          message:
            "ドメインは純粋に保つ。Date() で今の時刻を作らず、時刻は引数で受け取る（AGENTS.md §3）",
        });
      },
      NewExpression: (node) => {
        if (node.arguments.length > 0 || !isGlobal(node.callee, "Date", sourceCode)) return;
        context.report({
          node,
          message:
            "ドメインは純粋に保つ。引数なしの new Date() で今の時刻を作らず、時刻は引数で受け取る（AGENTS.md §3）",
        });
      },
    };
  },
});

/** `switch (state.kind)` や `switch (kind)` のように、判別子 `kind` で分けている switch か */
const switchesOnKind = (discriminant: ESTree.Node): boolean => {
  const node = unwrap(discriminant);
  if (node.type === "Identifier") return node.name === "kind";
  return node.type === "MemberExpression" && memberName(node) === "kind";
};

/** 文字列でないリテラルの case か（`case 0:`・`case -1:`・`case true:`・`case null:`） */
const isNonStringLiteral = (test: ESTree.Node): boolean => {
  if (test.type === "Literal") return typeof test.value !== "string";
  return (
    test.type === "UnaryExpression" &&
    (test.operator === "-" || test.operator === "+") &&
    test.argument.type === "Literal" &&
    typeof test.argument.value === "number"
  );
};

/**
 * 判別可能な union の switch か。JS のプラグインには型の情報がないので、形で見分ける。
 * 自分で定義する型の判別子は必ず `kind` で、値は文字列（AGENTS.md §2）。`kind` で分けていて、
 * 文字列でないリテラルの case がないものを判別可能な union の switch とみなす。
 * `case CIRCLE:` のような定数は値を辿れないので、判別可能な union の switch のほうに数える。
 * 型を見ないための限界: `kind` という名前の素の `string` で分ける switch も対象になり、
 * 別名の変数（`const k = x.kind; switch (k)`）で分ける switch は見逃す
 */
const isDiscriminatedUnionSwitch = (node: ESTree.SwitchStatement): boolean =>
  switchesOnKind(node.discriminant) &&
  node.cases.every(({ test }) => test === null || !isNonStringLiteral(test));

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
