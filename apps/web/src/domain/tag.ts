import { Result } from "@praha/byethrow";
import * as v from "valibot";

/** タグの名前の長さの上限（書記素の数。絵文字も1文字と数える） */
const TAG_NAME_MAX_LENGTH = 20;

/** 1人が使えるタグの種類の上限（GLOSSARY の「タグ」）。状態を見ながら広げるかもしれない */
export const TAG_KINDS_MAX = 20;

/**
 * 入力されたタグの名前を、記録する形に寄せる（ADR 0013）。
 *
 * NFKC で全角英数・記号を半角に寄せ、英字を小文字にし、前後の空白と先頭の `#` を外す。
 * ひらがなとカタカナは NFKC でも寄らない。
 */
const normalize = (input: string): string =>
  input.normalize("NFKC").trim().replace(/^#+/u, "").toLowerCase();

/** タグの名前。空白を含まない20文字まで。英字の大文字・小文字と全角・半角は区別しない */
const TagNameSchema = v.pipe(
  v.string(),
  v.transform(normalize),
  v.minLength(1),
  v.maxGraphemes(TAG_NAME_MAX_LENGTH),
  v.regex(/^\S+$/u),
  v.brand("TagName"),
);
export type TagName = v.InferOutput<typeof TagNameSchema>;

export const TagName = {
  schema: TagNameSchema,
} as const;

/**
 * 1件の記入につけるタグ。つけた順に並び、同じ名前は1つにまとめる。
 * 1件の記入に使えるタグの種類の上限を超えてはつけられない。
 */
const TagsSchema = v.pipe(
  v.array(TagNameSchema),
  v.transform((names): ReadonlyArray<TagName> => [...new Set(names)]),
  v.maxLength(TAG_KINDS_MAX),
);

export const Tags = {
  schema: TagsSchema,
} as const;

/** 使えるタグの種類の上限を超える（GLOSSARY の「タグ」） */
export type TagLimitExceeded = Readonly<{ kind: "TagLimitExceeded"; limit: number }>;

export const Tag = {
  /**
   * 記入に `tags` をつけても、使っているタグの種類が上限を超えないことを確かめる。
   *
   * `inUse` はその記入以外の削除していない記入についているタグ。どの記入にもついていない
   * タグは存在しないので数えない（ADR 0013）。
   */
  ensureWithinLimit: (
    inUse: ReadonlyArray<TagName>,
    tags: ReadonlyArray<TagName>,
  ): Result.Result<ReadonlyArray<TagName>, TagLimitExceeded> =>
    new Set([...inUse, ...tags]).size > TAG_KINDS_MAX
      ? Result.fail({ kind: "TagLimitExceeded", limit: TAG_KINDS_MAX })
      : Result.succeed(tags),

  /** 新しいタグ `name` を作れるか（つけているもの・使っているものなら作るのではないので、いつでもつけられる） */
  canAdd: (
    inUse: ReadonlyArray<TagName>,
    attached: ReadonlyArray<TagName>,
    name: TagName,
  ): boolean => Result.isSuccess(Tag.ensureWithinLimit(inUse, [...attached, name])),
} as const;

// ---------------------------------------------------------------------------
// 入力の候補（`GET /api/tags`）
// ---------------------------------------------------------------------------

/** 使っているタグの一覧。最近使った順（ADR 0013） */
export type TagList = Readonly<{ tags: ReadonlyArray<TagName> }>;

export const TagListJsonSchema: v.GenericSchema<unknown, TagList> = v.object({
  tags: v.array(TagNameSchema),
});

// ---------------------------------------------------------------------------
// ワークフローが使う読み書きの契約（kamae: 概念の隣に置き、1つの契約に1つの操作）
// ---------------------------------------------------------------------------

/** 削除していない記入についているタグを、最近使った順に読む */
export type ListTagsInUse = () => ReadonlyArray<TagName>;
