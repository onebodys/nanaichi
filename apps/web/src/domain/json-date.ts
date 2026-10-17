import * as v from "valibot";

/**
 * JSON にした時刻（`Date#toJSON` が書く ISO 8601 の文字列）を検証して `Date` に戻す。
 *
 * API の応答では時刻はすべてこの形になる。`*JsonSchema`（AGENTS.md §5）の部品として使う。
 */
export const JsonDateSchema = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.transform((iso) => new Date(iso)),
);
