import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Result } from "@praha/byethrow";

/**
 * 境界のスキーマ検証に失敗したことを表す。
 *
 * `issues` は valibot などの検証ライブラリが返す生の指摘で、**入力値を含むことがある**。
 * ログに出すときは `message` ではなく `path` だけを使うこと（PII の漏洩を防ぐ）。
 */
export type ValidationError = Readonly<{
  kind: "ValidationError";
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
}>;

/**
 * Standard Schema に準拠したスキーマを、byethrow の Result を返す parse 関数に変換する。
 *
 * スキーマごとに検証結果 → Result の変換を手書きしないよう、プロジェクトで1つだけ定義する
 * （kamae boundary-defense）。Zod / Valibot / ArkType のどれでも動く。
 */
export const schemaResult =
  <T>(schema: StandardSchemaV1<unknown, T>) =>
  (raw: unknown): Result.Result<T, ValidationError> => {
    const result = schema["~standard"].validate(raw);

    if (result instanceof Promise) {
      throw new TypeError("スキーマ検証は同期でなければならない");
    }
    if (result.issues) {
      return Result.fail({ kind: "ValidationError", issues: result.issues });
    }

    // `Result.succeed` は `ResultFor<T, Awaited<T>, never>` を返すため、ジェネリックな T では
    // `Result<T, E>` に代入できない。byethrow が公開している Success の形をそのまま組み立てる。
    return { type: "Success", value: result.value };
  };
