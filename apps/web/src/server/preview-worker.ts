const SESSION_PATH = "/api/auth/get-session";

/**
 * PR ごとのプレビューの Worker（ADR 0022）。本番の `app.ts` は使わない。
 *
 * 画面はセッションの確認に答えがないと記録先を決められず、読み込み直しの画面で止まる（ADR 0019）。
 * ここでは「ログインしていない」と答え、記録を端末の IndexedDB に置かせる。ほかの API はない。
 */
export default {
  fetch: (request: Request): Response =>
    new URL(request.url).pathname === SESSION_PATH
      ? Response.json(null)
      : new Response(null, { status: 404 }),
};
