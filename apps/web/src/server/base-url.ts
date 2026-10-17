import { HTTPException } from "hono/http-exception";

/**
 * この Worker を配信しているホストとして受け付けるもの。
 *
 * 本番は `wrangler deploy` の配信先（`wrangler.jsonc` の name とアカウントの workers.dev
 * サブドメインで決まる）、開発は Vite の dev サーバー。Worker 名やサブドメインを変えたら
 * ここも直す。Google Cloud Console に登録したリダイレクト URI と揃っている必要がある。
 */
const LOCAL_HOSTS = ["localhost:5173", "127.0.0.1:5173"] as const;

const ALLOWED_HOSTS = [...LOCAL_HOSTS, "nanaichi.onori-black1984.workers.dev"] as const;

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

/**
 * ローカルの開発サーバー（Vite の dev サーバー）へのリクエストか。
 *
 * テスト用のログイン（`test-sign-in.ts`）を、本番のホストでは設定に関わらず開かないために使う。
 */
export const isLocalRequest = (requestUrl: string): boolean =>
  LOCAL_HOSTS.some((host) => host === new URL(requestUrl).host);
