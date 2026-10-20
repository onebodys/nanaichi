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
// 設定画面のタグの一覧（`GET /api/tags/usage`）
// ---------------------------------------------------------------------------

/** 使っているタグと、それがついている削除していない記入の数 */
export type TagUsage = Readonly<{ name: TagName; entryCount: number }>;

/** 使っているタグとその記入の数の一覧。最近使った順（ADR 0013） */
export type TagUsageList = Readonly<{ tags: ReadonlyArray<TagUsage> }>;

export const TagUsageListJsonSchema: v.GenericSchema<unknown, TagUsageList> = v.object({
  tags: v.array(
    v.object({
      name: TagNameSchema,
      entryCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
    }),
  ),
});

// ---------------------------------------------------------------------------
// タグの削除（`DELETE /api/tags/:name`、GLOSSARY の「タグの削除」、ADR 0017）
// ---------------------------------------------------------------------------

/**
 * タグを削除するときに、そのタグがついている記入をどうするか。
 *
 * - `Detach`: タグを外すだけ
 * - `Reassign`: 使っている別のタグ `to` に付け替える
 */
export type TagDeletion =
  | Readonly<{ kind: "Detach" }>
  | Readonly<{ kind: "Reassign"; to: TagName }>;

const TagDeletionSchema = v.variant("kind", [
  v.object({ kind: v.literal("Detach") }),
  v.object({ kind: v.literal("Reassign"), to: TagNameSchema }),
]);

export const TagDeletion = {
  schema: TagDeletionSchema,
} as const;

/** 削除したタグ `name` と、ついていた記入をどうしたか */
export type DeletedTag = Readonly<{ name: TagName; deletion: TagDeletion }>;

/** JSON にした削除したタグ（`DELETE /api/tags/:name` の応答、同期メッセージ）を検証して戻す */
export const DeletedTagJsonSchema: v.GenericSchema<unknown, DeletedTag> = v.object({
  name: TagNameSchema,
  deletion: TagDeletionSchema,
});

/** 削除するタグか付け替え先のタグが、削除していない記入のどれにもついていない（存在しない） */
export type TagNotFound = Readonly<{ kind: "TagNotFound"; name: TagName }>;

/** 付け替え先が、削除するタグ自身 */
export type ReassignToSameTag = Readonly<{ kind: "ReassignToSameTag" }>;

/** 使っているタグ `inUse` に `name` があるか */
const ensureInUse = (
  inUse: ReadonlyArray<TagName>,
  name: TagName,
): Result.Result<TagName, TagNotFound> =>
  inUse.includes(name) ? Result.succeed(name) : Result.fail({ kind: "TagNotFound", name });

export const DeletedTag = {
  /**
   * タグ `deleted.name` を削除できるかを確かめる。削除するタグも付け替え先も、使っているタグ `inUse` の
   * どれかでなければならない（付け替え先は使っているタグから選ぶ。GLOSSARY の「タグの削除」）
   */
  ensureDeletable: (
    inUse: ReadonlyArray<TagName>,
    deleted: DeletedTag,
  ): Result.Result<DeletedTag, TagNotFound | ReassignToSameTag> => {
    switch (deleted.deletion.kind) {
      case "Detach":
        return Result.pipe(
          ensureInUse(inUse, deleted.name),
          Result.map(() => deleted),
        );
      case "Reassign": {
        const { to } = deleted.deletion;
        if (to === deleted.name) {
          return Result.fail({ kind: "ReassignToSameTag" });
        }
        return Result.pipe(
          ensureInUse(inUse, deleted.name),
          Result.andThen(() => ensureInUse(inUse, to)),
          Result.map(() => deleted),
        );
      }
    }
  },

  /**
   * 1件の記入のタグ `tags` から、削除したタグを外す（付け替えるなら付け替え先に置き換える）。
   * 付け替え先がすでについていれば、先にあった位置の1つにまとめる
   */
  applyTo: (tags: ReadonlyArray<TagName>, deleted: DeletedTag): ReadonlyArray<TagName> => {
    switch (deleted.deletion.kind) {
      case "Detach":
        return tags.filter((name) => name !== deleted.name);
      case "Reassign": {
        const { to } = deleted.deletion;
        return [...new Set(tags.map((name) => (name === deleted.name ? to : name)))];
      }
    }
  },
} as const;

// ---------------------------------------------------------------------------
// ワークフローが使う読み書きの契約（kamae: 概念の隣に置き、1つの契約に1つの操作）
// ---------------------------------------------------------------------------

/** 削除していない記入についているタグを、最近使った順に読む */
export type ListTagsInUse = () => ReadonlyArray<TagName>;

/** 削除していない記入についているタグと、その記入の数を、最近使った順に読む */
export type ListTagUsage = () => ReadonlyArray<TagUsage>;
