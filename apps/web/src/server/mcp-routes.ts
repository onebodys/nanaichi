import { createMcpHandler, requireBearerAuth } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { Allowlist } from "../domain/allowlist.ts";
import type { ApiErrorBody } from "../domain/api-error.ts";
import { allowlistFor, authFor } from "./auth-context.ts";
import { MCP_PATH, MCP_READ_SCOPE, mcpResourceOf } from "./auth.ts";
import { resolveBaseURL, servesMcpOn } from "./base-url.ts";
import type { AppEnv } from "./hono-context.ts";
import { createMcpServer } from "./mcp-server.ts";
import { accessTokenVerifier, userIdOf } from "./mcp-token.ts";

/** MCP サーバーの Protected Resource Metadata（RFC 9728）の場所。`mcp()` プラグインが配信する */
const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;

/**
 * MCP サーバー（GLOSSARY「MCP サーバー」、ADR 0017）。`/api/mcp` で Streamable HTTP を受ける。
 *
 * 画面の cookie ではなく、OAuth のアクセストークンでユーザーを決めるので、`requireSession` の外に置く。
 * トークンがなければ 401 と `WWW-Authenticate`（Protected Resource Metadata の場所）を返し、
 * MCP クライアントはそこから OAuth の流れを始める。
 */
export const mcpRoutes = new Hono<AppEnv>().all("/mcp", async (c) => {
  const baseURL = resolveBaseURL(c.req.url);
  if (!servesMcpOn(baseURL)) {
    return c.notFound();
  }
  const auth = authFor(c);
  const resource = mcpResourceOf(baseURL);
  // 発行者は Better Auth の baseURL（既定の basePath の `/api/auth` まで含む）。jwt プラグインが `iss` に入れる。
  // `auth.$context` から読むと、トークンのないリクエストでも Better Auth の初期化で D1 を読むので、ここで決める
  const issuer = `${baseURL}/api/auth`;

  const authInfo = await requireBearerAuth({
    verifier: accessTokenVerifier(auth, { issuer, resource }),
    requiredScopes: [MCP_READ_SCOPE],
    resourceMetadataUrl: `${baseURL}${PROTECTED_RESOURCE_METADATA_PATH}`,
    expectedResource: new URL(resource),
  })(c.req.raw);
  if (authInfo instanceof Response) {
    return authInfo;
  }

  // 許可リストから外したユーザーは、発行済みのトークンが残っていても読めないようにする（require-session.ts と同じ）
  const userId = userIdOf(authInfo);
  const user = await (await auth.$context).internalAdapter.findUserById(userId);
  if (user === null || !Allowlist.permits(allowlistFor(c), user.email)) {
    return c.json({ error: "EMAIL_NOT_ALLOWED" } satisfies ApiErrorBody, 403);
  }

  const userDO = c.env.USER_DO.getByName(userId);
  return createMcpHandler(() => createMcpServer(userDO)).fetch(c.req.raw, { authInfo });
});
