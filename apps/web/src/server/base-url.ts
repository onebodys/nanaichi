import { HTTPException } from "hono/http-exception";

/** 本番の正のオリジン（ADR 0021）。Google Cloud Console に登録したリダイレクト URI と揃っている必要がある */
const CANONICAL_ORIGIN = "https://nanaichi.app";

/**
 * 認証を受け付ける本番のホスト。`wrangler.jsonc` の `routes` のカスタムドメインと揃える。
 * workers.dev は正のオリジンへ転送するので含めない（`canonicalRedirectFor`）。
 */
const PRODUCTION_HOSTS = [new URL(CANONICAL_ORIGIN).host] as const;

/**
 * 正のオリジンへ転送すべきリクエストなら、転送先の URL（同じパスとクエリ）を返す（ADR 0021）。
 *
 * workers.dev（`nanaichi.onori-black1984.workers.dev` と、バージョンごとのプレビューの URL）は
 * すべて転送する。workers.dev を名乗るのはこの Worker 自身の URL だけなので、末尾で判定する。
 */
export const canonicalRedirectFor = (requestUrl: string): string | undefined => {
  const url = new URL(requestUrl);
  if (!url.hostname.endsWith(".workers.dev")) {
    return undefined;
  }
  return `${CANONICAL_ORIGIN}${url.pathname}${url.search}`;
};

/** Vite の dev サーバーをそのまま開くときのホスト（`vite.config.ts` の `server.port`） */
const DEV_SERVER_HOSTS = ["localhost:5173", "127.0.0.1:5173"] as const;

/**
 * ローカルの開発サーバーへのリクエストか。
 *
 * Vite の dev サーバーをそのまま開く `localhost:5173` に加えて、portless
 * （https://portless.sh/）が worktree ごとに割り振る `https://<ブランチ>.<名前>.localhost` を含める。
 * `.localhost` は RFC 6761 でループバックに予約された名前で、ブラウザは必ず手元のマシンに解決するので、
 * 本番のホストになることはない（ADR 0008）。ポートは portless の設定で変わるので問わない。
 */
export const isLocalRequest = (requestUrl: string): boolean => {
  const url = new URL(requestUrl);
  return DEV_SERVER_HOSTS.some((host) => host === url.host) || url.hostname.endsWith(".localhost");
};

/**
 * リクエストの URL から Better Auth の baseURL を決める。
 *
 * Better Auth の動的 baseURL（`baseURL.allowedHosts`）は Host ヘッダからホストを取るが、
 * fetch の仕様で `host` は `Headers` に載らないため、`auth.api.*` を直接呼ぶと解決に失敗する。
 * リクエストごとにインスタンスを作っているので、URL から決めて明示的に渡す方が確実。
 *
 * 許可していないホストなら例外にして、そのリクエストを処理しない（フェイルクローズ）。
 * portless のホストは Google のリダイレクト URI に登録できないので、そこでは Google の
 * ログインは通らない。代わりにテスト用のログイン（`test-sign-in.ts`）を使う。
 */
export const resolveBaseURL = (requestUrl: string): string => {
  const url = new URL(requestUrl);

  if (!(PRODUCTION_HOSTS.some((host) => host === url.host) || isLocalRequest(requestUrl))) {
    throw new HTTPException(400, { message: "このホストでは認証を受け付けていません" });
  }

  return url.origin;
};

/**
 * このホストで MCP サーバーを出せるか（ADR 0017）。
 *
 * MCP の仕様（と `@better-auth/mcp`）は、MCP サーバーの URL を https か loopback（`localhost`・`127.0.0.1`）に
 * 限っている。portless の `http://<ブランチ>.<名前>.localhost` はどちらでもないので、そこでは MCP サーバーを出さない。
 * ローカルで MCP クライアントを試すときは `http://localhost:5173` で開発サーバーを開く。
 */
export const servesMcpOn = (baseURL: string): boolean => {
  const url = new URL(baseURL);
  return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
};
