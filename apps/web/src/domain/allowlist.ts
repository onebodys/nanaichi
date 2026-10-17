import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { SensitiveEmailSchema, type SensitiveEmail } from "./email.ts";
import { schemaResult } from "./schema-result.ts";

/**
 * 登録を許可するメールアドレスの一覧（GLOSSARY の「許可リスト」）。
 *
 * 環境変数 `ALLOWED_EMAILS` にカンマ区切りで入れる。空文字なら誰も許可しない（フェイルクローズ）。
 * メールアドレスは PII なので、ログにそのまま出ないよう `Sensitive` に包んで保持する。
 */
export const AllowlistSchema = v.pipe(
  v.string(),
  v.transform((raw) => raw.split(",")),
  v.mapItems((item) => item.trim()),
  v.filterItems((item) => item !== ""),
  v.array(SensitiveEmailSchema),
  v.brand("Allowlist"),
);
export type Allowlist = v.InferOutput<typeof AllowlistSchema>;

const parseEmail = schemaResult(SensitiveEmailSchema);

export const Allowlist = {
  schema: AllowlistSchema,
  parse: schemaResult(AllowlistSchema),

  /** 許可リストに載っているメールアドレスか。ドメインの判断なので純粋関数にする。 */
  includes: (allowlist: Allowlist, email: SensitiveEmail): boolean =>
    allowlist.some((allowed) => allowed.unwrap() === email.unwrap()),

  /**
   * 生のメールアドレスを受け取り、登録を許可するか判断する。
   *
   * 許可リストに無いものだけでなく、メールアドレスとして解釈できない値も許可しない。
   * 判断を誤ると他人が登録できてしまうため、どちらの失敗も「許可しない」に倒す。
   */
  permits: (allowlist: Allowlist, rawEmail: unknown): boolean =>
    Result.unwrap(
      Result.pipe(
        parseEmail(rawEmail),
        Result.map((email) => Allowlist.includes(allowlist, email)),
      ),
      false,
    ),
} as const;
