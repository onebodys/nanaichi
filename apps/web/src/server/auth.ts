import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { Allowlist } from "../domain/allowlist.ts";
import type { AuthConfig } from "./env.ts";

/**
 * 許可リストに無いメールアドレスのユーザーを作らせない（Issue #2 の完了条件）。
 *
 * ここで拒否すれば `user` の行がそもそも作られないので、あとから使われることもない。
 * `body.code` を付けると、Better Auth が `errorCallbackURL` に `?error=<code>` を付けて
 * 戻してくれる（`callback.mjs` の `redirectOnError`）。画面はこれを見て理由を出す。
 */
export const guardUserCreation =
  (allowlist: Allowlist) =>
  async (user: { readonly email: string }): Promise<void> => {
    if (Allowlist.permits(allowlist, user.email)) {
      return;
    }

    throw APIError.from("FORBIDDEN", {
      code: "EMAIL_NOT_ALLOWED",
      message: "このメールアドレスでは登録できません",
    });
  };

/**
 * Better Auth のインスタンスを作る。
 *
 * Workers ではバインディング（env）がリクエスト時にしか手に入らないため、
 * モジュール直下のシングルトンにはせず、リクエストごとに1つ作る。
 * D1（Kysely アダプタ）はインスタンス生成時に DB へ問い合わせないので、
 * リクエストごとに作っても D1 への往復は増えない。
 */
export const createAuth = (config: AuthConfig, baseURL: string) =>
  betterAuth({
    database: config.database,
    secret: config.secret,
    // ホストはリクエストごとに base-url.ts が許可リストと突き合わせて決める。
    baseURL,
    trustedOrigins: [baseURL],
    // ログインは Google だけ。メール+パスワードは使わない。
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        prompt: "select_account",
      },
    },
    databaseHooks: {
      user: { create: { before: guardUserCreation(config.allowlist) } },
    },
  });

export type Auth = ReturnType<typeof createAuth>;
