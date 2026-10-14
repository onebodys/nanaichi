import { HTTPException } from "hono/http-exception";

/**
 * この Worker を配信しているホストとして受け付けるもの。
 * 本番は workers.dev、開発は Vite の dev サーバー。
 *
 * ワイルドカードは workers.dev のサブドメインを想定している。実際に OAuth を通せるのは
 * Google Cloud Console にリダイレクト URI を登録したホストだけなので、ここを広げても
 * 他人のホストでログインが成立することはない。
 */
const ALLOWED_HOSTS = ["localhost:5173", "127.0.0.1:5173", "*.workers.dev"] as const;

const matchesHost = (pattern: string, host: string): boolean =>
  pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : pattern === host;

/**
 * リクエストの URL から Better Auth の baseURL を決める。
 *
 * Better Auth の動的 baseURL（`baseURL.allowedHosts`）は Host ヘッダからホストを取るが、
 * fetch の仕様で `host` は `Headers` に載らないため、`auth.api.*` を直接呼ぶと解決に失敗する。
 * リクエストごとにインスタンスを作っているので、URL から決めて明示的に渡す方が確実。
 *
 * 許可していないホストなら例外にして、そのリクエストを処理しない（フェイルクローズ）。
 */
export const resolveBaseURL = (requestUrl: string): string => {
  const url = new URL(requestUrl);

  if (!ALLOWED_HOSTS.some((pattern) => matchesHost(pattern, url.host))) {
    throw new HTTPException(400, { message: "このホストでは認証を受け付けていません" });
  }

  return url.origin;
};
