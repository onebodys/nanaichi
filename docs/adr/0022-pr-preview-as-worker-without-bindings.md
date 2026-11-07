# PR ごとのプレビューは、バインディングを持たない別の Worker にする

PR の「オーナーが確かめる手順」をマージの前に実機で試せるよう、PR ごとの URL を用意する（Issue #127）。本番のデータに触れないことを最優先にし、プレビューは本番とは別の Worker `nanaichi-preview` にする。この Worker は D1 も Durable Object も、ほかのどのバインディングも持たない。プレビューで確かめられるのは、ログインしない「この端末の記録」（ADR 0019）で動く範囲だけにする。

- Cloudflare の Preview URLs（Version URLs）は、Durable Object を持つ Worker では作られない。`nanaichi` は UserDO を持つので使えない。`nanaichi-preview` は Durable Object を持たないので使える。
- 配る画面は本番と同じビルド（`dist/client`）。Worker のコードは本番の `app.ts` ではなく `server/preview-worker.ts` で、`GET /api/auth/get-session` に `null`（未ログイン）を返し、ほかの `/api/*` には 404 を返す。画面はセッションの確認に答えがないと読み込み直しの画面で止まるので、この1本だけが要る。
- URL は `https://pr-<番号>-nanaichi-preview.<アカウント>.workers.dev`。PR が更新されると、同じ URL が新しいバージョンを指す。`workers_dev` は `false` にして、alias のない URL は開かない。
- CI の `preview` が URL を PR にコメントする。コメントは1つにまとめ、更新のたびに書き換える。
- フォークと Dependabot の PR ではプレビューを作らない。secrets が渡らないため。CI のチェックだけで確かめる。
- テスト用のログイン（ADR 0008）はプレビューで開かない。

## Consequences

- プレビューから本番の D1 と UserDO に届く経路がない。`wrangler-config.test.ts` が、`wrangler.preview.jsonc` に許可した項目だけがあることを確かめる。バインディングを足すとこのテストが落ちる。
- ログイン、端末間の同期、MCP サーバー、この端末の記録の取り込みはプレビューで確かめられない。これらはマージのあとに本番で確かめる。
- API トークンは本番と同じなので、プレビューの CI のジョブは本番を書き換える権限を持つ。ジョブが動くのはこのリポジトリのブランチの PR だけで、トークンはアップロードのステップにだけ渡す。Workers の権限はアカウント全体にかかるので、トークンを分けても `nanaichi` の Worker を書き換える権限は残る。
- プレビューの URL は公開で、ログインなしで誰でも開ける。マージ前の画面が見えるが、本番と同じくビルドした画面だけで、記録は開いた人の端末にしかない。
- alias はアカウントの直近の 1000 件まで残り、古いものから消える。PR を閉じても URL は残るが、消す処理は持たない。
- `nanaichi-preview` がまだないアカウントでは `versions upload` が失敗する。Worker を作るときに1回だけ手元で `wrangler deploy` する（`docs/SETUP.md`）。
- ADR 0021 の workers.dev の転送は `app.ts` にあるので、プレビューの Worker には効かない。

## Considered Options

- `nanaichi` の Preview URLs を使う: Durable Object を持つ Worker では URL が作られない。作れたとしても、本番の D1 と UserDO を共有する。
- 専用の D1 と UserDO を持つ `nanaichi-preview` を1つ置く: ログインまで試せるが、Durable Object を持つので Preview URLs が使えず、URL は1つになる。同時に開いた PR が上書きし合う。ログインには Google のリダイレクト URI と secret の登録も要る。
- PR ごとに Worker と D1 を作る: 上の問題はなくなるが、PR を閉じるときに消す処理が要り、失敗すると資源が残る。この端末の記録で試せる範囲に対して重い。
- テスト用のログインをプレビューで開く: URL を知る人が誰でも許可済みのユーザーになれる。ローカルの開発サーバーでだけ開くという ADR 0008 の前提が崩れる。
- `app.ts` をバインディングなしで動かす: 本番のコードの全体が、バインディングがない場合を扱う必要がある。プレビューのための分岐が本番のコードに入る。
