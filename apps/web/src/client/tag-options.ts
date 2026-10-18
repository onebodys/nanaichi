import * as v from "valibot";
import { Tag, TAG_KINDS_MAX, TagName } from "../domain/tag.ts";

/**
 * タグの入力欄に出す候補の1つ。
 *
 * - `Existing`: 使っているタグ
 * - `New`: 入力した名前で新しく作るタグ。使えるタグの種類の上限に達していれば作れない
 */
export type TagOption =
  | Readonly<{ kind: "Existing"; name: TagName }>
  | Readonly<{ kind: "New"; name: TagName; creatable: boolean }>;

/** 入力が名前の規則に合わないときに出す案内 */
export type TagInputHint = Readonly<{ kind: "None" }> | Readonly<{ kind: "Invalid" }>;

const existing = (name: TagName): TagOption => ({ kind: "Existing", name });

/**
 * 入力中の文字列 `query` から、タグの入力欄に出す候補を決める（GLOSSARY の「タグ」）。
 *
 * - 使っているタグ（`known`、最近使った順）を優先して出す。入力があれば、名前の規則で寄せた入力を含むものだけ
 * - 入力が使っているタグのどれとも一致しなければ、最後に「新しく作る」を出す
 * - 入力が名前の規則に合わなければ（空白を含む・長すぎる）、候補は出さずに案内を出す
 *
 * `known` には入力欄でつけたまま、まだ書いていないタグが含まれないことがあるので、つけているタグ（`attached`）も候補に含める。
 */
export const tagOptionsOf = (
  input: Readonly<{
    query: string;
    known: ReadonlyArray<TagName>;
    attached: ReadonlyArray<TagName>;
  }>,
): Readonly<{ options: ReadonlyArray<TagOption>; hint: TagInputHint }> => {
  const candidates = [...new Set([...input.known, ...input.attached])];
  if (input.query.trim() === "" || input.query.trim().replace(/^[#＃]+/u, "") === "") {
    return { options: candidates.map(existing), hint: { kind: "None" } };
  }
  const parsed = v.safeParse(TagName.schema, input.query);
  if (!parsed.success) {
    return { options: [], hint: { kind: "Invalid" } };
  }
  const name = parsed.output;
  const matches = candidates.filter((candidate) => candidate.includes(name)).map(existing);
  if (candidates.includes(name)) {
    return { options: matches, hint: { kind: "None" } };
  }
  return {
    options: [
      ...matches,
      { kind: "New", name, creatable: Tag.canAdd(input.known, input.attached, name) },
    ],
    hint: { kind: "None" },
  };
};

/** 候補の表示。新しく作るものと、作れないものはそうとわかるようにする */
export const tagOptionLabelOf = (option: TagOption): string => {
  switch (option.kind) {
    case "Existing":
      return `#${option.name}`;
    case "New":
      return option.creatable
        ? `#${option.name} を新しく作る`
        : `#${option.name} は作れません（タグは${TAG_KINDS_MAX}種類まで）`;
  }
};
