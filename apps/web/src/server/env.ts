import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { AllowlistSchema, type Allowlist } from "../domain/allowlist.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import { describeIssuePaths } from "./validation-error.ts";

declare global {
  /**
   * wrangler が生成するバインディング（`DB` / `USER_DO`）に、secret として登録する値を足す。
   * secret は wrangler.jsonc に書かないため `wrangler types` では生成されず、ここで宣言する。
   */
  interface Env {
    /** Better Auth の署名鍵。32文字以上。`wrangler secret put BETTER_AUTH_SECRET` で登録する */
    readonly BETTER_AUTH_SECRET: string;
    readonly GOOGLE_CLIENT_ID: string;
    readonly GOOGLE_CLIENT_SECRET: string;
    /** 許可リスト。カンマ区切りのメールアドレス。PII なので secret として登録する */
    readonly ALLOWED_EMAILS: string;
  }
}

const AuthEnvSchema = v.object({
  BETTER_AUTH_SECRET: v.pipe(v.string(), v.minLength(32)),
  GOOGLE_CLIENT_ID: v.pipe(v.string(), v.nonEmpty()),
  GOOGLE_CLIENT_SECRET: v.pipe(v.string(), v.nonEmpty()),
  ALLOWED_EMAILS: AllowlistSchema,
});

/** 認証まわりで必要な設定とバインディング。境界で検証済みの値だけを持つ。 */
export type AuthConfig = Readonly<{
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
  allowlist: Allowlist;
  database: D1Database;
}>;

const parseAuthEnv = schemaResult(AuthEnvSchema);

/**
 * バインディングから認証の設定を組み立てる。値はすべて実行時に外から来るため、
 * 型を信じずスキーマで検証する（kamae boundary-defense）。
 */
export const parseAuthConfig = (env: Env): Result.Result<AuthConfig, ValidationError> =>
  Result.pipe(
    parseAuthEnv(env),
    Result.map((parsed) => ({
      secret: parsed.BETTER_AUTH_SECRET,
      googleClientId: parsed.GOOGLE_CLIENT_ID,
      googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
      allowlist: parsed.ALLOWED_EMAILS,
      database: env.DB,
    })),
  );

/**
 * 項目ごとに、設定されていなかったときに何をすればよいか。
 *
 * 「BETTER_AUTH_SECRET が不正」だけでは、未設定なのか短すぎるのか分からず、
 * 本番で 500 が出たときに原因へたどり着けない。値そのものは出せないので、
 * 代わりに直し方を出す。
 */
const HOW_TO_FIX: Readonly<Record<string, string>> = {
  BETTER_AUTH_SECRET: "32文字以上を `pnpm cf secret put BETTER_AUTH_SECRET` で登録する",
  GOOGLE_CLIENT_ID: "`pnpm cf secret put GOOGLE_CLIENT_ID` で登録する",
  GOOGLE_CLIENT_SECRET: "`pnpm cf secret put GOOGLE_CLIENT_SECRET` で登録する",
  ALLOWED_EMAILS: "許可するメールアドレスを `pnpm cf secret put ALLOWED_EMAILS` で登録する",
};

/**
 * 検証エラーをログに出せる文字列にする。
 *
 * `issue.message` は入力値を含むことがあり、`ALLOWED_EMAILS` なら PII が、
 * `BETTER_AUTH_SECRET` なら鍵そのものがログに出てしまう。どの項目をどう直すかだけを返す。
 */
export const describeValidationError = (error: ValidationError): string =>
  describeIssuePaths(error)
    .map((path) => {
      const howToFix = HOW_TO_FIX[path];
      return howToFix === undefined ? path : `${path}（${howToFix}）`;
    })
    .join(", ");
