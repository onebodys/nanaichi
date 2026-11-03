# 本番の URL は nanaichi.app だけにし、workers.dev へのアクセスは Worker がすべて転送する

一般公開に向けて `nanaichi.app` を取得した（Issue #115）。本番の正の URL を `https://nanaichi.app` だけにし、これまでの `https://nanaichi.onori-black1984.workers.dev` へのアクセスは、静的アセットを含めてすべて `https://nanaichi.app` の同じパスとクエリへ 308 で転送する。両方のドメインで使える状態は残さない。

- `wrangler.jsonc` の `routes` に `nanaichi.app` を Workers のカスタムドメインとして足す。wrangler は `routes` があると workers.dev を既定で止めるので、転送を届けるために `workers_dev: true` を明示する（`wrangler-config.test.ts` で確かめる）。
- 認証を受け付ける本番のホストは `nanaichi.app` だけにする（`base-url.ts` の `PRODUCTION_HOSTS`）。workers.dev はどうせ転送するので、受け付けない。
- 転送は Worker の先頭のミドルウェアで行う（`app.ts`）。ホストの判定は `base-url.ts` の `canonicalRedirectFor` にまとめる。ホスト名が `.workers.dev` で終われば転送する。バージョンごとのプレビューの URL（`<id>-nanaichi.onori-black1984.workers.dev`）も同じ扱いになる。
- 静的アセットへのリクエストも Worker を通すため、`assets.run_worker_first` を `true` にし、`ASSETS` バインディングを足す。API でないリクエストは Worker が `ASSETS` に渡す。`not_found_handling: "single-page-application"` はバインディングを通しても効く。知らない `/api/*` は SPA の画面ではなく 404 にする。
- 転送は 308 にする。301 と違い、MCP クライアントの POST をメソッドと本文を保ったまま転送できる。

## Consequences

- オリジンが変わるので、次のものは nanaichi.app に引き継がれない。ログインしていない人の記録（IndexedDB、ADR 0019）、ログイン中のセッション（cookie）、インストール済みの PWA と Service Worker、MCP クライアントに登録した URL（OAuth の resource と issuer もホストから決まるため、登録し直しになる。ADR 0017）。
- 静的アセットへのリクエストも Worker の呼び出しとして数えられ、課金の対象になる。いまの利用者の数では問題にならない。増えて気になれば、workers.dev への流入が十分に減ったところで `workers_dev: false` にして転送をやめ、`run_worker_first` を元の `["/api/*", "/.well-known/*"]` に戻す（そのときはルート `/` の出し分け（ADR 0018）で Worker が先に受けるパスと合わせて考える）。
- Google の OAuth クライアントと同意画面には `nanaichi.app` を登録する（`docs/SETUP.md`）。デプロイの前に済ませておかないとログインできなくなる。
- `canonical-redirect.workers.test.ts` が、wrangler.jsonc のとおりに起動した Worker で `/`・`/lp`・静的アセット・`/api/*` が転送されることを確かめる。`run_worker_first` を狭めると落ちる。

## Considered Options

- `run_worker_first` を広げずに、静的アセットは workers.dev のまま返す: アプリとアイコンが両方のドメインで開けてしまい、IndexedDB の記録やログインがドメインごとに分かれる。「両方で使える状態を残さない」に反する。
- Cloudflare の Redirect Rules で転送する: workers.dev はゾーンではないので使えない。
- いまの Worker の名前を変えて、`nanaichi` の名前で転送だけをする Worker を別に置く: 静的アセットを Worker に通さずに済むが、Durable Object（UserDO）の名前空間が Worker の名前に結びついているので、記録を移す手間とリスクが大きい。デプロイの経路も2つになる。
- `workers_dev: false` にして workers.dev を止める: 古い URL を開いた人や、Slack に貼った URL がつながらなくなる。転送しておけば、そのまま nanaichi.app に着く。
