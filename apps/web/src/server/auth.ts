import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { Allowlist } from "../domain/allowlist.ts";
import { servesMcpOn } from "./base-url.ts";
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

/** MCP サーバーのパス（mcp-routes.ts）。アクセストークンはこの URL に宛てて発行する */
export const MCP_PATH = "/api/mcp";

/** MCP サーバーの URL。OAuth の resource（RFC 8707）で、アクセストークンの `aud` になる */
export const mcpResourceOf = (baseURL: string): string => `${baseURL}${MCP_PATH}`;

/**
 * MCP クライアントに許す範囲。記録の読み取りだけ（GLOSSARY「MCP サーバー」）。
 * 書き換える操作を足すときは、別の scope にして連携の許可で選べるようにする。
 */
export const MCP_READ_SCOPE = "journal:read";

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
    // jwt プラグインの `/token`（セッションから JWT を作る）は使わない。MCP のトークンは OAuth の `/oauth2/token` で出す
    disabledPaths: ["/token"],
    plugins: [
      // アクセストークンを JWT にして、MCP のルートが D1 を引かずに署名で確かめられるようにする（ADR 0023）
      jwt(),
      // portless の `*.localhost` では MCP サーバーを出さない（base-url.ts の `servesMcpOn`）
      ...(servesMcpOn(baseURL)
        ? [
            mcp({
              resource: mcpResourceOf(baseURL),
              loginPage: "/login",
              consentPage: "/oauth/consent",
              scopes: ["openid", "offline_access", MCP_READ_SCOPE],
              // MCP クライアントは事前に登録できないので、動的登録（RFC 7591）を誰にでも開く。
              // 登録しただけでは何も読めず、ユーザーが連携の許可で選んだクライアントだけが読める（ADR 0023）
              allowDynamicClientRegistration: true,
              allowUnauthenticatedClientRegistration: true,
              // Claude Code などは手元で待ち受ける `http://localhost:<port>/callback` に戻させる。application_type を
              // 送らないクライアントも、loopback の http ならネイティブアプリとして登録できるよう推し量る（RFC 8252）
              clientRegistrationDefaultApplicationType: "infer",
            }),
          ]
        : []),
    ],
  });

export type Auth = ReturnType<typeof createAuth>;
