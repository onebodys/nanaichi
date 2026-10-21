# LP は同じ Worker の静的な HTML にし、`/` をログインしているかで出し分ける

nanaichi の LP（Issue #90）を、アプリと同じ Worker・同じ URL で公開する。ログインしていない人が `/` を開くと LP、ログインしている人はこれまでどおりタイマーの画面が出る。LP からはログインへの導線を出さない（社内でドッグフーディングの参加者を集めるあいだは、オーナーが Slack で個別に案内する）。

- LP は `apps/web/landing.html` を Vite の2つ目の入口にした、素の HTML・CSS と小さな TypeScript（`src/client/landing/`）。React もアプリの JS も読み込まない。Vite の `environments.client.build.rollupOptions.input` に足す（Worker の環境に足すと Worker のビルドが HTML を読もうとして失敗する）。
- `/` は Worker が先に受け（`wrangler.jsonc` の `run_worker_first`）、Better Auth でセッションを確かめて、ASSETS バインディングから `/`（index.html）か `/landing`（landing.html）を引いて返す（`server/landing-routes.ts`）。同じ URL で中身が変わるので `Vary: Cookie` を付ける。保護はこれまでどおり `/api/*` の `requireSession` が受け持ち、ここは画面の出し分けだけ。
- LP のいちばん上で、タイマーをその場で試せる。サーバーには何も送らず、アプリと同じドメイン（`Session`・`JournalEntry`・`deriveTimerState`）でページの中だけで動かす（`client/landing/demo-session.ts`）。時計を実時間の60倍で進めて1ラウンドを29秒で見せることもできる。
- 一般向けに公開するまでは `noindex` にする。

## Consequences

- PWA の `start_url`、ログインのあとの戻り先、通知を押したときに開く画面はどれも `/` のままでよく、ログインしている人の行き先は変わらない。
- ホーム画面に追加した PWA でログインが切れていると、`/` は LP になり、LP にはログインへの導線がないので戻れなくなる。LP は `display-mode: standalone` で開かれたら `/login` へ送る。ブラウザでログインが切れた人は `/login` を直接開く（セッションは使っていれば延びるので、切れることはまれ）。
- `/` へのリクエストのたびに Worker が動き、セッションを D1 で1回引く。
- ログインしたまま LP を確かめたいときは `/landing` を開く。
- LP の CSS は IBM Plex Sans JP の `@font-face` を unicode-range ごとに持つので大きい（アプリの CSS と同じ事情）。文字は使った範囲の分だけ読み込まれる。
- アナリティクスはまだ入れていない。入れるなら cookie を使わない Cloudflare Web Analytics を考える。

## Considered Options

- LP を別のアプリ（Astro など）にして別にデプロイする: LP には向いているが、`.astro` は Oxlint・Oxfmt・`vp check` の検査が十分に効かず、ビルドとデプロイの経路が2つになる。1枚のページには見合わない。ブログやドキュメントなど複数のページに育ったら考え直す。
- SPA のルートの1つにする: アプリの JS をすべて読み込むので重く、Slack に URL を貼ったときのプレビュー（OGP）を LP 専用にできない。
- LP を `/about` などの別のパスに置き、`/` には手を入れない: いちばん手堅いが、一般向けに公開するときにもう一度 URL を動かすことになる。オーナーの希望（最終的にアプリと同じ URL）にも合わない。
- cookie があるかだけで出し分ける（セッションを引かない）: D1 を読まずに済むが、壊れた cookie や切れたセッションでもアプリの画面になる。いまの利用者の数なら D1 を1回読んでも困らないので、確かめるほうを選んだ。
