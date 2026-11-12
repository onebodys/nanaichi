import type { Context } from "hono";
import type { Auth } from "./auth.ts";
import type { AuthConfig } from "./env.ts";

/** ログイン中のユーザーとセッション。`requireSession` を通ったリクエストでのみ存在する。 */
export type AuthSession = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

/**
 * リクエストが何でログインしているか。画面は cookie、ネイティブアプリは `Authorization: Bearer`（ADR 0029）。
 * `requireSession` が決める。
 */
export type Credential = "Cookie" | "Bearer";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** リクエストのバインディングから検証した認証の設定。`authConfigFor` が遅延して設定する */
    authConfig: AuthConfig | undefined;
    /** リクエストに紐づく Better Auth のインスタンス。`authFor` が遅延して設定する */
    auth: Auth | undefined;
    /** `requireSession` が設定する。未ログインなら undefined のまま */
    session: AuthSession | undefined;
    /** `requireSession` が設定する。session と同じく、未ログインなら undefined のまま */
    credential: Credential | undefined;
  };
};

/**
 * `requireSession` を通ったリクエストでのみ呼ぶ。
 *
 * 通っていなければルートの登録漏れ（実装の誤り）なので、想定内の失敗ではなく例外にする。
 */
export const sessionOf = (c: Context<AppEnv>): AuthSession => {
  const session = c.get("session");
  if (session === undefined) {
    throw new Error("requireSession を通っていないリクエストで session を参照した");
  }
  return session;
};

/** `requireSession` を通ったリクエストでのみ呼ぶ。通っていなければ `sessionOf` と同じく実装の誤り */
export const credentialOf = (c: Context<AppEnv>): Credential => {
  const credential = c.get("credential");
  if (credential === undefined) {
    throw new Error("requireSession を通っていないリクエストで credential を参照した");
  }
  return credential;
};
