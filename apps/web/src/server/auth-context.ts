import { Result } from "@praha/byethrow";
import type { Context } from "hono";
import type { Allowlist } from "../domain/allowlist.ts";
import { createAuth, type Auth } from "./auth.ts";
import { resolveBaseURL } from "./base-url.ts";
import { type AuthConfig, describeValidationError, parseAuthConfig } from "./env.ts";
import type { AppEnv } from "./hono-context.ts";

/**
 * リクエストのバインディングから、検証済みの認証の設定を返す。
 *
 * Workers のバインディングはリクエスト時にしか手に入らないのでモジュール直下では作れない。
 * 同じリクエスト内では1つを使い回し、設定の検証を繰り返さない。
 */
export const authConfigFor = (c: Context<AppEnv>): AuthConfig => {
  const cached = c.get("authConfig");
  if (cached !== undefined) {
    return cached;
  }

  const config = parseAuthConfig(c.env);
  if (Result.isFailure(config)) {
    // 設定漏れは想定内の失敗ではなく障害。どの項目が不正かだけを出し、値は出さない。
    throw new Error(`認証の設定が読み込めません: ${describeValidationError(config.error)}`);
  }

  c.set("authConfig", config.value);
  return config.value;
};

/**
 * リクエストに紐づく Better Auth のインスタンスを返す。
 *
 * 同じリクエスト内では1つを使い回し、アダプタの初期化を繰り返さない。
 */
export const authFor = (c: Context<AppEnv>): Auth => {
  const cached = c.get("auth");
  if (cached !== undefined) {
    return cached;
  }

  const auth = createAuth(authConfigFor(c), resolveBaseURL(c.req.url));
  c.set("auth", auth);
  return auth;
};

export const allowlistFor = (c: Context<AppEnv>): Allowlist => authConfigFor(c).allowlist;
