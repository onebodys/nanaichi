# E2E テスト

画面を実際のブラウザ（chromium）で動かして確かめるテスト。ランナーは [e2e](https://e2e.tester.army)。
設定は `apps/web/e2e.config.ts`、テストは `apps/web/tests/*.e2e.ts` に置く。

## 実行する

```bash
pnpm test:e2e    # リポジトリのどこからでもよい
```

- ローカルの D1 にマイグレーションを当ててから、ランナーが `vp dev`（`localhost:5173`）を起動してテストする。
  手元で `pnpm dev` を起動済みならそのサーバーを使う。
- 開発サーバーにはダミーの認証設定を環境変数で渡すので、`.dev.vars` がなくても動く。Google には繋がない。
- chromium がなければ初回に自動でダウンロードされる。CI では先に `vp exec --filter web e2e-web install chromium --with-deps` を実行する。
- 結果は `apps/web/.e2e/`（git 管理外）に出る。失敗したテストは `.e2e/results/<テスト>/trace.md` に手順と失敗時の画面が残り、開発サーバーのログは `.e2e/logs/app.log`。
- CI（`.github/workflows/ci.yml` の `e2e` ジョブ）でも PR と main への push のたびに走る。CI のローカル D1 は毎回空から始まる。
  落ちたときは、実行結果の画面の「Artifacts」から `e2e-results`（`apps/web/.e2e/` 一式）をダウンロードすれば、
  失敗したテストの `results/<テスト>/trace.md` と開発サーバーのログ `logs/app.log` を見られる。
  E2E が落ちた main ではデプロイしない。
- CI ではリトライが1回入る。リトライで通ったテストは flaky として数え、ジョブは成功のままなので、実行結果の画面の Summary（`.e2e/summary.md`）で確かめる。
  見出しに `7 flaky` のように件数が出て、`flaky tests passed on a retry` を開くと落ちたステップが読める。
  `{ serial: true }` のグループは丸ごとやり直すので、1件落ちるとグループの全員が flaky になる。本当に落ちたのは、ステップの失敗が書かれているテストだけ。
  flaky を見つけたら Issue にする（AGENTS.md §1）。
- 1ファイルだけ: `pnpm --filter web exec e2e run tests/smoke.e2e.ts`。ブラウザを表示するなら `--headed`。

## テストを書く

書き方はエージェント向けの e2e スキル（`.agents/skills/e2e`）にまとまっている。
テスト名は日本語で、`GLOSSARY.md` の用語を使った場面として書く（AGENTS.md §1）。

### ログイン済みの画面のテスト

ログインが要る画面のテストには `{ session: "signedIn" }` を付ける。`tests/sign-in.setup.e2e.ts` が先に
ログイン済みの状態を `signedIn` として保存し、そのテストはログイン済みの状態から始まる。

```ts
test("ログインするとホームが表示される", { session: "signedIn" }, async ({ app, screen }) => {
  await app.open("/");
  await expect(screen.getByRole("button", { name: "ログアウト" })).toBeVisible();
});
```

- ログインは Google を通さず、テスト用のログイン（下記）で `e2e@example.com`（`e2e.config.ts` の `ALLOWED_EMAILS`）として行う。
  ユーザーの名前は `Test User`。
- ログアウトするテストは `{ session: "signedInToSignOut" }` を使う。ログアウトするとサーバー側のセッションが消えるので、
  `signedIn` でログアウトすると、後に走るテストがログイン画面に飛ばされる。
- ジャーナル記入のテスト（`tests/journal.e2e.ts`）は `{ session: "journalWriter" }` を使う。`e2e-journal@example.com` として
  ログインする別のユーザーなので、同じ時間に走るタイマーのテストとセッション（UserDO）が混ざらない。
- 同期のテスト（`tests/sync.e2e.ts`）は `{ session: "syncWatcher" }`（`e2e-sync@example.com`）を使う。他のテストの操作が
  同期メッセージとして届かないよう、別のユーザーにしている。ブラウザの画面を「スマホ」とし、テストから同じ cookie で
  API を直接呼んで「PC での操作・記入」とする。切断は、初期化スクリプトでページの `WebSocket` を差し替えて起こす
  （ブラウザのオフラインの切り替えでは、開いている WebSocket は切れない）。
- 保存されるのはブラウザの cookie だけで、サーバーの状態（D1 や UserDO のセッション）は持ち越さない。
  ローカルの D1 は実行のあいだで残るので、テストは前の実行の状態に依存しないように書く。
  たとえば同じ日にセッションが1ページ分（10件）より多く溜まると、今日の区切りの完了セット数はタイムラインだけでは確定せず、
  サーバーが数えたスタッツの今日の数を出す（ADR 0011、0014）。ページの時計だけを進めるテストではサーバーの数が合わないので、
  完了セット数を確かめるテストは、期待した数が出るまで「さらに読み込む」を押す（`tests/journal.e2e.ts`）。
- 空の D1 から走らせると、同じユーザーのログイン済みの状態を用意する setup が同時にユーザーを作ろうとする。
  テスト用のログインは、先に作られたユーザーがいればそれを使う（`src/server/test-auth.ts`）。

### 時間の経過・音・通知のテスト

フェーズの自動的な切り替わりを本当に7分待たずに確かめるため、`tests/timer.e2e.ts` と `tests/journal.e2e.ts` は
初期化スクリプト（`tests/page-clock.ts` の `installPageClock`）でページの `Date.now` を進められるようにしている。画面は端末の時刻を必ず `Date.now()` から読み、時計のずれで補正して
残り時間を計算する（ADR 0003）ので、ページの時計を進めればサーバーを待たずにフェーズが進む。

- `Date` そのものを差し替えるとログインの判定まで巻き込むので、差し替えるのは `Date.now` だけにする。
- 時計は、同期の WebSocket が繋がっていて、通信の途中でないときにだけ進める（`advanceClock` が待つ）。画面は API の往復の前後の時刻で
  時計のずれを測るので、往復の途中で進めるとずれを誤って測る。また繋がった直後の読み込みで測り直したずれは、進めた分を打ち消す。
- ログインしない使い方（`tests/device.e2e.ts`、ADR 0019）の記録先はこの端末で、同期の WebSocket がない。時計は `advanceClock(browser, minutes, { socket: false })` で、通信が落ち着くのだけを待って進める。ブラウザの保存先はテストごとに空から始まる。同じブラウザの別のタブは操作できないので、同じ origin の iframe を埋め込んで代わりにする（保存先も BroadcastChannel も共有する）。
- 時計を進めたあとの操作は、サーバーの時刻と食い違うので拒否されうる。進めたあとに送るのはどの状態でもできる終了だけにする。
  切り替え待ちから進める（ADR 0016）も、サーバーではまだ集中中なので拒否される。押した結果は結合テスト（`advance-mode-api.workers.test.ts`）で確かめる。
- フェーズの進め方はアカウントの設定で実行のあいだで残るので、`tests/timer.e2e.ts` は画面を開く前にすべて自動へ戻す。
- 音（Web Audio）・通知・Wake Lock はヘッドレスのブラウザでは確かめられないので、呼ばれたことを記録する偽物に置き換えて確かめる。
- タイマーのテストはどれも同じユーザーのセッションを使うので、`describe(..., { serial: true })` で並べて走らせない。

### レート制限

E2E は同じユーザーで画面を開き直し・操作し続けるので、ユーザーごとのレート制限（10 秒 100 回、ADR 0018）に当たって 429 で落ちる。
`e2e.config.ts` が開発サーバーに `E2E_RELAX_RATE_LIMIT=enabled` を渡し、`vite.config.ts` がそのときだけ上限を上げる。
効くのは開発サーバー（`vp dev`）だけで、ビルドした Worker の設定には入らない。制限そのものは `rate-limit.workers.test.ts` で確かめる。

## スクリーンショットを残す

画面に関わる PR で、オーナーが手元で何も動かさずに画面を見られるようにする（AGENTS.md §1、Issue #123）。

- `tests/screenshots.e2e.ts` が、ホーム・設定・スタッツ・タイマーの各フェーズ（集中・ジャーナル・休憩・終了）を PC の幅（1280px）とスマホの幅（375px）で撮り、`.e2e/screenshots/` に置く。画面を足したらこのテストにも足す。
- CI の `e2e` ジョブが `scripts/screenshot-gallery.ts` で全部を1枚の HTML にまとめ、artifact `screenshots.html` として上げる。
- 見る場所は、PR のコメント「画面のスクリーンショット」のリンク。実行結果の画面の Summary にも同じリンクと画面の一覧が出る。コメントは push のたびに最新の実行に更新される。リンクの有効期限は 14 日。
- 個別の PNG は `e2e-results` の `screenshots/` にも入る。
- 手元で作るには `pnpm test:e2e` のあと、`apps/web` で `node scripts/screenshot-gallery.ts` を実行し、`.e2e/screenshots.html` を開く。
- スタッツはサーバーが数えるので、ページの時計だけを進めるこのテストでは記録のない状態が写る。

## テスト用のログイン（ADR 0008）

`GET /api/test/sign-in?email=<メールアドレス>` を開くと、Google を通さずにそのユーザーでログインし、
cookie を付けてホーム（`/`）へ戻る。ユーザーがいなければ作る。

- 開くのは、バインディング `TEST_SIGN_IN=enabled` があり、かつ `localhost:5173` / `127.0.0.1:5173` か portless の `*.localhost` へのリクエストのときだけ。
  それ以外（本番を含む）では 404 になる。`TEST_SIGN_IN` は `wrangler.jsonc` にも `wrangler secret` にも登録しない。
- 許可リスト（`ALLOWED_EMAILS`）に載っていないメールアドレスでは 403 になり、ログインしない。
- E2E では `e2e.config.ts` が `TEST_SIGN_IN=enabled` を渡す。手元の `pnpm dev` では `.dev.vars` に書く（`.dev.vars.example` に入っている）。

- 開発サーバーで開いたログイン画面には、Google のボタンの下に「開発用ログイン」のフォームが出る。メールアドレスを入れると
  このテスト用のログインを開く。本番のビルドには入らない。

## worktree ごとに開発サーバーを立てる（portless）

worktree ごとに `pnpm dev` を立てると 5173 がぶつかる。[portless](https://portless.sh/) を使うと、worktree（ブランチ）ごとに
名前のついた URL で開ける（Issue #43）。portless はプロジェクトの依存に入れず、グローバルに入れる。

```bash
mise use -g npm:portless                     # 初回だけ。mise なら Node のバージョンに関わらず使える
portless proxy start --port 1355 --https     # proxy を常駐させる（sudo なし。マシンの再起動後はもう一度）
pnpm dev:portless                            # → https://<ブランチ名>.nanaichi.localhost:1355
```

- `pnpm dev:portless` は TTY がないので、proxy が止まっていると sudo を聞けずに落ちる。先に proxy を起動しておく。
  初回はローカルの CA を信頼するか聞かれることがある。443 番（`sudo portless proxy start --https`）でもよいが、proxy が root で常駐する。
- URL は起動時に表示される。`portless list` でも見られる。portless が割り振った `PORT` / `HOST` で Vite が待ち受ける（`vite.config.ts`）。
- このホストでは Google のログインは通らない（リダイレクト URI に登録できない）。ログイン画面の「開発用ログイン」を使う。
  そのため `.dev.vars` に `TEST_SIGN_IN=enabled` と、ログインするメールアドレスを入れた `ALLOWED_EMAILS` が要る。
- 新しい worktree ではローカルの D1 が空なので、先に `pnpm cf d1 migrations apply nanaichi --local` を当てる。
- portless の `--tld` で `.localhost` 以外にすると、認証がホストを受け付けない（`src/server/base-url.ts`）。
- 本物の Google ログインを確かめるときは、portless を使わずに `pnpm dev`（`localhost:5173`）で起動する。
- E2E は今までどおり `localhost:5173` で走る。

## ワーカーが画面を確かめる

画面に関わる変更は、テストとは別に実際にブラウザで開いて確かめる（AGENTS.md §1）。

1. テスト用のログインを有効にして開発サーバーを起動する。`.dev.vars` があれば `pnpm dev` でよい
   （`TEST_SIGN_IN=enabled` と、ログインするメールアドレスを `ALLOWED_EMAILS` に入れておく）。
   `.dev.vars` がなければ、E2E と同じダミーの値を環境変数で渡す:

   ```bash
   CLOUDFLARE_INCLUDE_PROCESS_ENV=true BETTER_AUTH_SECRET=local-dummy-secret-0123456789abcdef \
     GOOGLE_CLIENT_ID=dummy GOOGLE_CLIENT_SECRET=dummy ALLOWED_EMAILS=e2e@example.com \
     TEST_SIGN_IN=enabled pnpm dev
   ```

2. ブラウザでテスト用のログインを開き、確かめたい画面へ進む。agent-browser なら:

   ```bash
   agent-browser open "http://localhost:5173/api/test/sign-in?email=e2e%40example.com"  # ホームに戻る
   agent-browser snapshot -i                    # 画面の要素を見る
   agent-browser screenshot home.png            # 手元で見るスクリーンショット
   agent-browser eval 'fetch("/api/session/current").then(r => r.json()).then(JSON.stringify)'  # API の応答も見られる
   ```

   e2e の MCP サーバー（`e2e mcp`、スキルの `references/mcp.md`）を使う場合も、最初に同じ URL を開けばよい。

3. 確かめた手順と結果を PR の本文に書く。画面は CI が撮ったスクリーンショット（「スクリーンショットを残す」）で見てもらう。
   `tests/screenshots.e2e.ts` が撮らない画面を変えたら、このテストに足す。終わったら開発サーバーを止める。

いまはモデルを設定していないので、`agent.act` などの AI ステップは使えない。
`screen` と `expect` だけの決定的なテストを書く。AI ステップが必要になったら、モデルとその認証を
`e2e.config.ts` の `agents` に足す（スキルの `references/setup.md`）。

## Mac アプリの画面を確かめる（ADR 0028）

e2e は macOS のネイティブアプリを動かせないので、Mac アプリ（`apps/apple/`）の画面は XCUITest で確かめる。

- `sh apps/apple/scripts/ui-test.sh` で、`apps/apple/project.yml` から Xcode のプロジェクトを作り直し、XCUITest を走らせる。XcodeGen（`brew install xcodegen`）と Xcode が要る。Xcode は `DEVELOPER_DIR` か `xcode-select` のものを使う
- テストで `attachScreenshot(of:named:)` を呼ぶと、その名前で `apps/apple/.uitest/screenshots/<名前>.png` に書き出す。名前の頭に番号を付けると、その順に並ぶ
- CI の `apple-ui` ジョブも同じスクリプトを走らせ、Web の E2E と同じく画面の一覧（`screenshots.html`）へのリンクを PR にコメントする。macOS のランナーは長くかかり分数も多く数えられるので、**PR に `ui-test` のラベルを付けたとき**（ラベルがある間は push のたびに）か、Actions の画面から手で走らせたときだけ走る。画面に関わる PR では、ラベルを付けて画面を確かめてから外す
- XCUITest はデバッグのビルドにだけある環境変数でアプリを起動する（`apps/apple/Nanaichi/LaunchConfiguration.swift`）。`NANAICHI_TIME_SCALE` で時計を速め（15倍なら1ラウンドが2分ほど）、`NANAICHI_TIME_ORIGIN` に同じ起点を渡せば開き直しても時刻が続く。`NANAICHI_DATABASE` はアプリのコンテナの中の記録のファイル名で、`NANAICHI_RESET_DATABASE=1` なら開く前に消す。リリースのビルドはこれらを読まない
- ローカルで XCUITest を走らせるには、Mac の開発者モード（`DevToolsSecurity -enable`）か、最初に出る認証のダイアログでの許可が要る。許可していないと `The test runner failed to initialize for UI testing` で落ちる
- ドメインは `apps/apple/NanaichiKit` の `swift test` で確かめる。TS のテストが書き出したゴールデンケース（`fixtures/golden/`）を通す。CI の `apple` ジョブは、Swift のコードかゴールデンケースが変わったときに走る。手元でも、同じ条件で push 時のフックとエージェントの Stop フックが `swift test` を走らせる（`scripts/swift-test-if-changed.sh`）。Command Line Tools が選ばれていれば `/Applications` のいちばん新しい Xcode を使う
