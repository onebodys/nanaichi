import { Result } from "@praha/byethrow";
import type { ListTagUsage, TagUsageList } from "../domain/tag.ts";

export type GetTagUsageDeps = Readonly<{ listTagUsage: ListTagUsage }>;

/**
 * 設定画面のタグの一覧に出す、使っているタグとその記入の数を返す（GLOSSARY の「タグの削除」）。
 *
 * 削除していない記入についているタグを、最近使った順に読むだけ。想定内の失敗はない。
 */
export const getTagUsage = (deps: GetTagUsageDeps) => (): Result.Result<TagUsageList, never> =>
  Result.succeed({ tags: deps.listTagUsage() });
