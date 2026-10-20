import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { createLocalJWKSet, jwtVerify } from "jose";
import * as v from "valibot";
import type { Auth } from "./auth.ts";

/**
 * MCP のアクセストークン（JWT）の中身のうち、使うもの。
 *
 * - `sub`: ユーザー ID。どのユーザーの UserDO を読むかを決める
 * - `azp`: トークンを受け取った MCP クライアントの ID
 * - `cnf`: DPoP で送り手に縛ったトークンに付く。DPoP の証明は確かめていないので、付いていたら断る
 */
const AccessTokenClaimsSchema = v.object({
  sub: v.pipe(v.string(), v.nonEmpty()),
  azp: v.pipe(v.string(), v.nonEmpty()),
  scope: v.optional(v.string(), ""),
  exp: v.number(),
  cnf: v.optional(v.unknown()),
});

const invalidToken = (message: string) => new OAuthError(OAuthErrorCode.InvalidToken, message);

/** トークンを受け取った MCP クライアントのユーザー。`AuthInfo.extra` に入れて MCP のツールへ渡す */
export const userIdOf = (authInfo: AuthInfo): string => {
  const userId = authInfo.extra?.["userId"];
  if (typeof userId !== "string") {
    throw new Error("トークンを確かめていない AuthInfo からユーザーを読もうとした");
  }
  return userId;
};

/**
 * MCP のアクセストークンを確かめる（ADR 0017）。
 *
 * Better Auth の `requireMcpAuth` は JWKS を自分の `/api/auth/jwks` へ HTTP で取りに行くが、
 * Workers が自分自身の URL へ fetch すると届かないことがある。同じ Worker の中にある Better Auth から
 * 公開鍵を直接読み、署名・発行者・宛先（この MCP サーバー）・期限を確かめる。
 * 失敗はすべて `invalid_token` にし、SDK の `requireBearerAuth` が 401 と `WWW-Authenticate` を返す。
 */
export const accessTokenVerifier = (
  auth: Auth,
  expected: Readonly<{ issuer: string; resource: string }>,
) => ({
  verifyAccessToken: async (token: string): Promise<AuthInfo> => {
    const keys = createLocalJWKSet(await auth.api.getJwks());
    const verified = await jwtVerify(token, keys, {
      issuer: expected.issuer,
      audience: expected.resource,
    }).catch(() => undefined);
    if (verified === undefined) {
      throw invalidToken("アクセストークンを確かめられない");
    }

    const claims = v.safeParse(AccessTokenClaimsSchema, verified.payload);
    if (!claims.success) {
      throw invalidToken("アクセストークンの中身が足りない");
    }
    if (claims.output.cnf !== undefined) {
      throw invalidToken("DPoP で縛ったアクセストークンは受け付けていない");
    }

    return {
      token,
      clientId: claims.output.azp,
      scopes: claims.output.scope.split(" ").filter((scope) => scope !== ""),
      expiresAt: claims.output.exp,
      // 宛先は jwtVerify で確かめ済み。SDK にも同じ値を渡して、二重に突き合わせる
      resource: new URL(expected.resource),
      extra: { userId: claims.output.sub },
    };
  },
});
