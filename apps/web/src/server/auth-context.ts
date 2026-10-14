import { Result } from "@praha/byethrow";
import type { Context } from "hono";
import { createAuth, type Auth } from "./auth.ts";
import { resolveBaseURL } from "./base-url.ts";
import { describeValidationError, parseAuthConfig } from "./env.ts";
import type { AppEnv } from "./hono-context.ts";

/**
 * リクエストに紐づく Better Auth のインスタンスを返す。
 *
 * Workers のバインディングはリクエスト時にしか手に入らないのでモジュール直下では作れない。
 * 同じリクエスト内では1つを使い回し、アダプタの初期化を繰り返さない。
 */
export const authFor = (c: Context<AppEnv>): Auth => {
  const cached = c.get("auth");
  if (cached !== undefined) {
    return cached;
  }

  const config = parseAuthConfig(c.env);
  if (Result.isFailure(config)) {
    // 設定漏れは想定内の失敗ではなく障害。どの項目が不正かだけを出し、値は出さない。
    throw new Error(`認証の設定が読み込めません: ${describeValidationError(config.error)}`);
  }

  const auth = createAuth(config.value, resolveBaseURL(c.req.url));
  c.set("auth", auth);
  return auth;
};
