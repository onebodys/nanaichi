import { Result } from "@praha/byethrow";
import type { Context } from "hono";
import { Hono } from "hono";
import * as v from "valibot";
import { Allowlist } from "../domain/allowlist.ts";
import type { ApiErrorBody } from "../domain/api-error.ts";
import { SensitiveEmailSchema } from "../domain/email.ts";
import { schemaResult } from "../domain/schema-result.ts";
import { authConfigFor } from "./auth-context.ts";
import { isLocalRequest } from "./base-url.ts";
import type { AppEnv } from "./hono-context.ts";
import { createTestAuth } from "./test-auth.ts";
import { describeIssuePaths } from "./validation-error.ts";

/**
 * テスト用のログイン（ADR 0008）。
 *
 * `GET /api/test/sign-in?email=<許可リストのメールアドレス>` を開くと、Google を通さずに
 * そのユーザーでログインした cookie を付けてホーム（`/`）へ戻す。E2E のテストや、ワーカーが
 * ブラウザで画面を確かめるときに使う（docs/E2E.md）。
 *
 * 次の両方を満たすときだけ開く。どちらかでも欠ければ、経路がないものとして 404 を返す。
 * - バインディング `TEST_SIGN_IN` が `enabled`（`.dev.vars` と `e2e.config.ts` でだけ渡す）
 * - ローカルの開発サーバーのホストへのリクエスト（本番のホストでは設定に関わらず開かない）
 */

const TestSignInEnabledSchema = v.object({ TEST_SIGN_IN: v.literal("enabled") });
const isEnabledByBinding = (env: Env): boolean =>
  Result.isSuccess(schemaResult(TestSignInEnabledSchema)(env));

const isTestSignInOpen = (c: Context<AppEnv>): boolean =>
  isEnabledByBinding(c.env) && isLocalRequest(c.req.url);

const parseQuery = schemaResult(v.object({ email: SensitiveEmailSchema }));

export const testSignInRoutes = new Hono<AppEnv>().get("/test/sign-in", async (c) => {
  if (!isTestSignInOpen(c)) {
    return c.notFound();
  }

  const query = parseQuery(c.req.query());
  if (Result.isFailure(query)) {
    return c.json(
      {
        error: "INVALID_REQUEST",
        paths: describeIssuePaths(query.error),
      } satisfies ApiErrorBody,
      400,
    );
  }

  // 本物のログインと同じく、許可リストに載っていないユーザーではログインさせない
  const config = authConfigFor(c);
  const { email } = query.value;
  if (!Allowlist.includes(config.allowlist, email)) {
    return c.json({ error: "EMAIL_NOT_ALLOWED" } satisfies ApiErrorBody, 403);
  }

  const login = await createTestAuth({
    database: config.database,
    secret: config.secret,
    baseURL: new URL(c.req.url).origin,
  }).signInAs(email.unwrap());

  for (const cookie of login.setCookies) {
    c.header("Set-Cookie", cookie, { append: true });
  }
  return c.redirect("/");
});
