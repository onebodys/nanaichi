# LP は同じ Worker の静的な HTML にし、ベータ版のあいだは `/lp` に置く

nanaichi の LP（Issue #90）を、アプリと同じ Worker の静的な HTML として公開する。ベータ版のあいだは `/lp` に置き、`/` はこれまでどおりアプリ（未ログインならログイン画面へ）のままにする。一般向けに公開するときに、LP を `/` に移す（ログインしているかで出し分ける。下の「Considered Options」）。LP からはログインへの導線を出さない（社内でドッグフーディングの参加者を集めるあいだは、オーナーが Slack で個別に案内する）。

- LP は `apps/web/lp.html` を Vite の2つ目の入口にした、素の HTML・CSS と小さな TypeScript（`src/client/landing/`）。React もアプリの JS も読み込まない。Vite の `environments.client.build.rollupOptions.input` に足す（Worker の環境に足すと Worker のビルドが HTML を読もうとして失敗する）。
- `/lp` は Workers Static Assets の `html_handling` の既定で `lp.html` を返す。Worker は通らない。
- LP のいちばん上で、タイマーをその場で試せる。サーバーには何も送らず、アプリと同じドメイン（`Session`・`JournalEntry`・`deriveTimerState`）でページの中だけで動かす（`client/landing/demo-session.ts`）。時計を実時間の60倍で進めて1ラウンドを29分ではなく29秒で見せることもできる。
- LP にはベータ版であることと、いまできること・これからのこと（Web・PWA・端末間の同期は使える、iPhone・Apple Watch・Mac のアプリはこれから。ADR 0015）を出す。
- 一般向けに公開するまでは `noindex` にする。

## Consequences

- `/`、PWA の `start_url`、ログインのあとの戻り先、通知を押したときに開く画面は、どれもこれまでと変わらない。
- LP を `/` に移すときは、Worker が `/` を先に受けて（`run_worker_first`）セッションで `index.html` か `lp.html` を出し分け、`Vary: Cookie` を付ける。そのときは、ホーム画面に追加した PWA でログインが切れていると LP にはログインの導線がないので戻れなくなる。LP を `display-mode: standalone` で開いたら `/login` へ送る必要がある。
- LP の CSS は IBM Plex Sans JP の `@font-face` を unicode-range ごとに持つので大きい（アプリの CSS と同じ事情）。文字は使った範囲の分だけ読み込まれる。
- アナリティクスはまだ入れていない。入れるなら cookie を使わない Cloudflare Web Analytics を考える。

## Considered Options

- いますぐ `/` をログインしているかで出し分ける: 最終的にはこの形にする。ただベータ版のあいだは参加者が限られ、`/` にリクエストのたびに D1 を引く Worker を挟み、PWA の戻り先の回り道まで抱えるほどの理由がない。公開するときに移す。
- LP を別のアプリ（Astro など）にして別にデプロイする: LP には向いているが、`.astro` は Oxlint・Oxfmt・`vp check` の検査が十分に効かず、ビルドとデプロイの経路が2つになる。1枚のページには見合わない。ブログやドキュメントなど複数のページに育ったら考え直す。
- SPA のルートの1つにする: アプリの JS をすべて読み込むので重く、Slack に URL を貼ったときのプレビュー（OGP）を LP 専用にできない。
