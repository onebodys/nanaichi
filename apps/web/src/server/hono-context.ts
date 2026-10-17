import type { Context } from "hono";
import type { Allowlist } from "../domain/allowlist.ts";
import type { Auth } from "./auth.ts";

/** ログイン中のユーザーとセッション。`requireSession` を通ったリクエストでのみ存在する。 */
export type AuthSession = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

/** リクエストごとに作る Better Auth のインスタンスと、それを作ったときの許可リスト。 */
export type RequestAuth = Readonly<{ auth: Auth; allowlist: Allowlist }>;

export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** リクエストに紐づく Better Auth のインスタンスと許可リスト。`authFor` が遅延して設定する */
    auth: RequestAuth | undefined;
    /** `requireSession` が設定する。未ログインなら undefined のまま */
    session: AuthSession | undefined;
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
