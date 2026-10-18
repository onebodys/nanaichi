import { createAuthClient } from "better-auth/react";

/**
 * SPA と API は同じ Worker から配信されるので、baseURL はブラウザの origin でよい。
 * 認証のパスは Better Auth の既定（/api/auth）で、Hono 側の `/api` + `/auth/*` と一致する。
 */
export const authClient = createAuthClient();

/** ログアウトする。セッションが無くなるので、ルートの beforeLoad がログイン画面へ送る */
export const signOut = async () => {
  await authClient.signOut();
  window.location.href = "/login";
};
