import { Result } from "@praha/byethrow";
import type { Context } from "hono";
import type { Allowlist } from "../domain/allowlist.ts";
import { createAuth, type Auth } from "./auth.ts";
import { resolveBaseURL } from "./base-url.ts";
import { describeValidationError, parseAuthConfig } from "./env.ts";
import type { AppEnv, RequestAuth } from "./hono-context.ts";

/**
 * リクエストに紐づく Better Auth のインスタンスと、検証済みの許可リストを返す。
 *
 * Workers のバインディングはリクエスト時にしか手に入らないのでモジュール直下では作れない。
 * 同じリクエスト内では1つを使い回し、アダプタの初期化や設定の検証を繰り返さない。
 */
const requestAuthFor = (c: Context<AppEnv>): RequestAuth => {
  const cached = c.get("auth");
  if (cached !== undefined) {
    return cached;
  }

  const config = parseAuthConfig(c.env);
  if (Result.isFailure(config)) {
    // 設定漏れは想定内の失敗ではなく障害。どの項目が不正かだけを出し、値は出さない。
    throw new Error(`認証の設定が読み込めません: ${describeValidationError(config.error)}`);
  }

  const requestAuth = {
    auth: createAuth(config.value, resolveBaseURL(c.req.url)),
    allowlist: config.value.allowlist,
  };
  c.set("auth", requestAuth);
  return requestAuth;
};

export const authFor = (c: Context<AppEnv>): Auth => requestAuthFor(c).auth;

export const allowlistFor = (c: Context<AppEnv>): Allowlist => requestAuthFor(c).allowlist;
