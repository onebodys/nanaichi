import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { TAG_KINDS_MAX, TagName } from "../domain/tag.ts";
import { tagOptionLabelOf, tagOptionsOf } from "./tag-options.ts";

const tag = (name: string) => v.parse(TagName.schema, name);
const known = [tag("読書"), tag("設計"), tag("book")];

describe("タグの入力欄の候補", () => {
  test("何も入力していなければ、使っているタグを最近使った順に出す", () => {
    expect(tagOptionsOf({ query: "", known, attached: [] }).options).toEqual([
      { kind: "Existing", name: "読書" },
      { kind: "Existing", name: "設計" },
      { kind: "Existing", name: "book" },
    ]);
  });

  test("# だけを入力したときも、使っているタグをすべて出す", () => {
    expect(tagOptionsOf({ query: "＃", known, attached: [] }).options).toHaveLength(3);
  });

  test("入力を含む使っているタグを優先し、一致するものがなければ最後に新しく作る候補を出す", () => {
    expect(tagOptionsOf({ query: "#読", known, attached: [] }).options).toEqual([
      { kind: "Existing", name: "読書" },
      { kind: "New", name: "読", creatable: true },
    ]);
  });

  test("大文字・全角で入力しても、使っているタグに寄せて探す", () => {
    expect(tagOptionsOf({ query: "ＢＯＯＫ", known, attached: [] }).options).toEqual([
      { kind: "Existing", name: "book" },
    ]);
  });

  test("入力欄でつけたまま、まだ書いていないタグも候補に出す", () => {
    expect(tagOptionsOf({ query: "", known: [], attached: [tag("新しい")] }).options).toEqual([
      { kind: "Existing", name: "新しい" },
    ]);
  });

  test("空白を含む入力には候補を出さず、名前の規則の案内を出す", () => {
    expect(tagOptionsOf({ query: "読書 メモ", known, attached: [] })).toEqual({
      options: [],
      hint: { kind: "Invalid" },
    });
  });

  test(`${TAG_KINDS_MAX}種類を使っていると、新しいタグは作れない候補として出す`, () => {
    const twenty = Array.from({ length: TAG_KINDS_MAX }, (_, i) => tag(`tag${i + 1}`));

    const { options } = tagOptionsOf({ query: "読書", known: twenty, attached: [] });

    expect(options).toEqual([{ kind: "New", name: "読書", creatable: false }]);
    expect(options.map(tagOptionLabelOf)).toEqual([
      `#読書 は作れません（タグは${TAG_KINDS_MAX}種類まで）`,
    ]);
  });
});
