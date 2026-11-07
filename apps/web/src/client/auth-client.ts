import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

/**
 * SPA と API は同じ Worker から配信されるので、baseURL はブラウザの origin でよい。
 * 認証のパスは Better Auth の既定（/api/auth）で、Hono 側の `/api` + `/auth/*` と一致する。
 *
 * `oauthProviderClient` は、MCP クライアントの認可の途中で開いた画面（ログイン・連携の許可）の URL に
 * 署名つきの OAuth のクエリがあれば、ログインや許可のリクエストにそれを添える。ログインのあとに
 * 認可の続き（連携の許可の画面）へ進めるのはこのため（ADR 0023）。署名がなければ何もしない。
 */
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });

let signingOut = false;

/** ログアウトする。ログインしていない状態でも使えるので、ホームに戻り、この端末の記録を開く（ADR 0019） */
export const signOut = async () => {
  signingOut = true;
  await authClient.signOut();
  window.location.href = "/";
};

/**
 * ログインが切れていたとき（API が `UNAUTHENTICATED` を返したとき）にログイン画面へ送る。
 * ログアウトの最中に飛んでいた通信の失敗で、ログアウトの移動先（`/`）を上書きしない
 */
export const redirectToLogin = () => {
  if (!signingOut) {
    window.location.href = "/login";
  }
};
