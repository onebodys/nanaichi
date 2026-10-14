import * as v from "valibot";
import { Sensitive } from "./sensitive.ts";

/**
 * メールアドレス。大文字小文字の違いで許可リストの照合が外れないよう正規化する。
 */
export const EmailSchema = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.email(),
  v.brand("Email"),
);
export type Email = v.InferOutput<typeof EmailSchema>;

/**
 * PII なので境界で `Sensitive` に包む（AGENTS.md「境界での検証と PII」）。
 */
export const SensitiveEmailSchema = v.pipe(EmailSchema, v.transform(Sensitive.of));
export type SensitiveEmail = v.InferOutput<typeof SensitiveEmailSchema>;
