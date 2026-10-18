import { useRef, useState } from "react";
import { TAG_KINDS_MAX, type TagName } from "../domain/tag.ts";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
} from "./components/ui/combobox.tsx";
import { tagOptionLabelOf, tagOptionsOf, type TagOption } from "./tag-options.ts";

/** つけているタグを、候補の値（Combobox の value）の形にする */
const asOptions = (names: ReadonlyArray<TagName>): Array<TagOption> =>
  names.map((name) => ({ kind: "Existing", name }));

/** 選んだ候補のうち、つけられるものの名前。作れない新しいタグは選べないが、念のため除く */
const namesOf = (options: ReadonlyArray<TagOption>): ReadonlyArray<TagName> => [
  ...new Set(
    options
      .filter((option) => option.kind === "Existing" || option.creatable)
      .map((option) => option.name),
  ),
];

/**
 * タグの入力欄（GLOSSARY の「タグ」）。つけたタグをチップで並べ、入力すると候補を出す。
 *
 * 候補は使っているタグを優先し、一致するものがなければ新しく作れる（`tagOptionsOf`）。
 * Enter で送信しないよう、ジャーナル記入の form の外に置くこと。
 *
 * - `known`: 使っているタグ（最近使った順）
 * - `attached`: つけているタグ
 * - `className`: タグを並べる欄の見た目を上書きする（入力欄のカードの中に置くときなど）
 */
export const TagInput = ({
  known,
  attached,
  onChange,
  label = "タグ",
  className,
}: Readonly<{
  known: ReadonlyArray<TagName>;
  attached: ReadonlyArray<TagName>;
  onChange: (tags: ReadonlyArray<TagName>) => void;
  label?: string;
  className?: string;
}>) => {
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLDivElement | null>(null);
  const { options, hint } = tagOptionsOf({ query, known, attached });

  return (
    <Combobox<TagOption, true>
      multiple
      items={options}
      value={asOptions(attached)}
      onValueChange={(next) => {
        onChange(namesOf(next));
        setQuery("");
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      // 候補は名前の規則で寄せた入力で絞り込んである（tagOptionsOf）
      filter={null}
      itemToStringLabel={(option) => option.name}
      isItemEqualToValue={(a, b) => a.name === b.name}
      // 入力したら最初の候補を選んだ状態にし、Enter でつけられるようにする
      autoHighlight
    >
      <ComboboxChips ref={anchor} className={className}>
        {attached.map((name) => (
          <ComboboxChip key={name} removeLabel={`#${name} を外す`}>
            #{name}
          </ComboboxChip>
        ))}
        <ComboboxChipsInput
          aria-label={label}
          placeholder={attached.length === 0 ? "#タグをつける" : ""}
        />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>
          {hint.kind === "Invalid"
            ? `タグの名前は空白を含まない20文字までです`
            : `使ったことのあるタグはまだありません（${TAG_KINDS_MAX}種類まで作れます）`}
        </ComboboxEmpty>
        <ComboboxList>
          {(option: TagOption) => (
            <ComboboxItem
              key={`${option.kind}:${option.name}`}
              value={option}
              disabled={option.kind === "New" && !option.creatable}
            >
              {tagOptionLabelOf(option)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
};

/** 記入についたタグの表示（タイムライン） */
export const TagList = ({ tags }: Readonly<{ tags: ReadonlyArray<TagName> }>) =>
  tags.length === 0 ? null : (
    <ul aria-label="タグ" className="flex flex-wrap gap-1">
      {tags.map((name) => (
        <li key={name} className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          #{name}
        </li>
      ))}
    </ul>
  );
