import { Result } from "@praha/byethrow";
import type { ListTagsInUse, TagList } from "../domain/tag.ts";

export type GetTagsDeps = Readonly<{ listTagsInUse: ListTagsInUse }>;

/**
 * 入力の候補に出す、使っているタグの一覧を返す（GLOSSARY の「タグ」、ADR 0013）。
 *
 * 削除していない記入についているタグを、最近使った順に読むだけ。想定内の失敗はない。
 */
export const getTags = (deps: GetTagsDeps) => (): Result.Result<TagList, never> =>
  Result.succeed({ tags: deps.listTagsInUse() });
