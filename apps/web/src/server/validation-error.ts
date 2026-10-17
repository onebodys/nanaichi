import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ValidationError } from "../domain/schema-result.ts";

const describePath = (path: StandardSchemaV1.Issue["path"]): string => {
  if (!path || path.length === 0) return "(root)";
  return path
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment),
    )
    .join(".");
};

/**
 * 検証エラーのうち、どの項目が不正かだけを取り出す。
 *
 * `issue.message` は入力値を含むことがあり、メールアドレスや秘密の値、ジャーナル記入の本文が
 * ログや応答に出てしまう。外に出すのは項目の位置だけにする。
 */
export const describeIssuePaths = (error: ValidationError): ReadonlyArray<string> =>
  error.issues.map((issue) => describePath(issue.path));
