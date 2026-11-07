import * as v from "valibot";
import { goldenCases, settled } from "../testing/golden.ts";
import { parsedBy, type Parsed } from "../testing/golden-values.ts";
import { DeletedTag, Tag, TAG_KINDS_MAX, TagName, Tags } from "./tag.ts";

/** 場面の入力に使う、記録する形のタグの名前 */
const tag = (name: string) => v.parse(TagName.schema, name);
const tagsNumbered = (count: number, prefix = "tag") =>
  Array.from({ length: count }, (_, i) => tag(`${prefix}${i + 1}`));

const INVALID = { kind: "Failure", error: { kind: "Invalid" } } as const;
const FAMILY = "👨‍👩‍👧";

const parseTagName: (input: Readonly<{ value: unknown }>) => Parsed<string> = parsedBy(
  TagName.schema,
);

goldenCases("TagName.parse", parseTagName, [
  {
    name: "先頭の # と前後の空白を外す",
    input: { value: "  #読書 " },
    expected: { kind: "Success", value: "読書" },
  },
  {
    name: "英字の大文字・小文字を区別しない",
    input: { value: "#Reading" },
    expected: { kind: "Success", value: "reading" },
  },
  {
    name: "全角の英数字と ＃ は半角と同じタグになる",
    input: { value: "＃ＲＥＡＤＩＮＧ２" },
    expected: { kind: "Success", value: "reading2" },
  },
  {
    name: "ひらがなはカタカナに寄せず、ひらがなのまま",
    input: { value: "どくしょ" },
    expected: { kind: "Success", value: "どくしょ" },
  },
  {
    name: "カタカナはひらがなに寄せず、カタカナのまま",
    input: { value: "ドクショ" },
    expected: { kind: "Success", value: "ドクショ" },
  },
  { name: "空の名前はつけられない", input: { value: "" }, expected: INVALID },
  { name: "# だけの名前はつけられない", input: { value: "#" }, expected: INVALID },
  { name: "空白だけの名前はつけられない", input: { value: "  " }, expected: INVALID },
  { name: "空白を含む名前はつけられない", input: { value: "読書 メモ" }, expected: INVALID },
  {
    name: "全角の空白を含む名前はつけられない",
    input: { value: "読書　メモ" },
    expected: INVALID,
  },
  {
    name: "20文字まではつけられる",
    input: { value: "あ".repeat(20) },
    expected: { kind: "Success", value: "あ".repeat(20) },
  },
  {
    name: "絵文字は1文字と数えるので、絵文字20個はつけられる",
    input: { value: FAMILY.repeat(20) },
    expected: { kind: "Success", value: FAMILY.repeat(20) },
  },
  { name: "21文字はつけられない", input: { value: "あ".repeat(21) }, expected: INVALID },
]);

const parseTags: (input: Readonly<{ value: unknown }>) => Parsed<ReadonlyArray<string>> = parsedBy(
  Tags.schema,
);

goldenCases("Tags.parse", parseTags, [
  {
    name: "つけた順に並び、表記ゆれを寄せたうえで同じ名前は1つにまとめる",
    input: { value: ["読書", "#Book", "読書", "book"] },
    expected: { kind: "Success", value: ["読書", "book"] },
  },
]);

goldenCases(
  "Tag.ensureWithinLimit",
  (input: Readonly<{ inUse: ReadonlyArray<TagName>; tags: ReadonlyArray<TagName> }>) =>
    settled(Tag.ensureWithinLimit(input.inUse, input.tags)),
  [
    {
      name: `ほかの記入で使っているタグとあわせて${TAG_KINDS_MAX}種類までならつけられる`,
      input: { inUse: tagsNumbered(TAG_KINDS_MAX - 1), tags: [tag("読書")] },
      expected: { kind: "Success", value: ["読書"] },
    },
    {
      name: `${TAG_KINDS_MAX}種類を使っていると、新しいタグはつけられない`,
      input: { inUse: tagsNumbered(TAG_KINDS_MAX), tags: [tag("読書")] },
      expected: { kind: "Failure", error: { kind: "TagLimitExceeded", limit: TAG_KINDS_MAX } },
    },
    {
      name: `${TAG_KINDS_MAX}種類を使っていても、使っているタグならつけられる`,
      input: { inUse: tagsNumbered(TAG_KINDS_MAX), tags: [tag("tag1"), tag("tag2")] },
      expected: { kind: "Success", value: ["tag1", "tag2"] },
    },
  ],
);

goldenCases(
  "Tag.canAdd",
  (
    input: Readonly<{
      inUse: ReadonlyArray<TagName>;
      attached: ReadonlyArray<TagName>;
      name: TagName;
    }>,
  ) => Tag.canAdd(input.inUse, input.attached, input.name),
  [
    {
      name: "入力欄にタグがなければ、上限に1つ余裕のあるとき新しいタグは作れる",
      input: { inUse: tagsNumbered(TAG_KINDS_MAX - 1), attached: [], name: tag("読書") },
      expected: true,
    },
    {
      name: "入力欄でつけているタグとあわせて上限を超えるなら、新しいタグは作れない",
      input: {
        inUse: tagsNumbered(TAG_KINDS_MAX - 1),
        attached: [tag("読書")],
        name: tag("本"),
      },
      expected: false,
    },
    {
      name: "入力欄でつけているタグがあっても、使っているタグならつけられる",
      input: {
        inUse: tagsNumbered(TAG_KINDS_MAX - 1),
        attached: [tag("読書")],
        name: tag("tag1"),
      },
      expected: true,
    },
  ],
);

const reading = tag("読書");
const design = tag("設計");
const review = tag("レビュー");
const inUse = [reading, design, review];

goldenCases(
  "DeletedTag.ensureDeletable",
  (input: Readonly<{ inUse: ReadonlyArray<TagName>; deleted: DeletedTag }>) =>
    settled(DeletedTag.ensureDeletable(input.inUse, input.deleted)),
  [
    {
      name: "使っているタグは、外すだけなら削除できる",
      input: { inUse, deleted: { name: reading, deletion: { kind: "Detach" } } },
      expected: { kind: "Success", value: { name: "読書", deletion: { kind: "Detach" } } },
    },
    {
      name: "使っている別のタグになら、付け替えて削除できる",
      input: { inUse, deleted: { name: reading, deletion: { kind: "Reassign", to: design } } },
      expected: {
        kind: "Success",
        value: { name: "読書", deletion: { kind: "Reassign", to: "設計" } },
      },
    },
    {
      name: "どの記入にもついていないタグは存在しないので、削除できない",
      input: { inUse, deleted: { name: tag("料理"), deletion: { kind: "Detach" } } },
      expected: { kind: "Failure", error: { kind: "TagNotFound", name: "料理" } },
    },
    {
      name: "付け替え先は使っているタグから選ぶので、使っていないタグには付け替えられない",
      input: {
        inUse,
        deleted: { name: reading, deletion: { kind: "Reassign", to: tag("料理") } },
      },
      expected: { kind: "Failure", error: { kind: "TagNotFound", name: "料理" } },
    },
    {
      name: "削除するタグ自身には付け替えられない",
      input: { inUse, deleted: { name: reading, deletion: { kind: "Reassign", to: reading } } },
      expected: { kind: "Failure", error: { kind: "ReassignToSameTag" } },
    },
  ],
);

goldenCases(
  "DeletedTag.applyTo",
  (input: Readonly<{ tags: ReadonlyArray<TagName>; deleted: DeletedTag }>) =>
    DeletedTag.applyTo(input.tags, input.deleted),
  [
    {
      name: "外すだけなら、記入のタグから削除したタグだけがなくなり、残りの順は変わらない",
      input: {
        tags: [design, reading, review],
        deleted: { name: reading, deletion: { kind: "Detach" } },
      },
      expected: ["設計", "レビュー"],
    },
    {
      name: "付け替えると、削除したタグのあった位置に付け替え先がつく",
      input: {
        tags: [design, reading],
        deleted: { name: reading, deletion: { kind: "Reassign", to: review } },
      },
      expected: ["設計", "レビュー"],
    },
    {
      name: "付け替え先がすでについている記入では、先にあった位置の1つにまとめる",
      input: {
        tags: [reading, review, design],
        deleted: { name: reading, deletion: { kind: "Reassign", to: design } },
      },
      expected: ["設計", "レビュー"],
    },
    {
      name: "削除したタグがついていない記入のタグは変わらない",
      input: {
        tags: [design, review],
        deleted: { name: reading, deletion: { kind: "Reassign", to: design } },
      },
      expected: ["設計", "レビュー"],
    },
  ],
);
