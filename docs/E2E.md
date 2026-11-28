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
- CI では再試行が1回入る。再試行で通ったテストは flaky として数え、ジョブは成功のままなので、実行結果の画面の Summary（`.e2e/summary.md`）で確かめる。
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
  完了セット数を確かめるテストは、昨日より前の区切りが出るか続きがなくなるまで「さらに読み込む」を押して今日の分を読み終えてから数を読む（`tests/journal.e2e.ts`）。
  途中で止まった実行のセッションは走り続け、本当の完了セットになって今日の数に残るので、数は決まった値ではなく、始めたときの数からの増え方で確かめる。
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

## Mac と iPhone のアプリの画面を確かめる（ADR 0028、ADR 0031）

e2e は macOS のネイティブアプリを動かせないので、Mac アプリ（`apps/apple/`）の画面は XCUITest で確かめる。iPhone のアプリ（`apps/apple/NanaichiPhone`）も、いまは同じく XCUITest で iOS のシミュレーターの上で確かめる（e2e の `@e2e-dev/mobile` はまだ入れていない）。

- `sh apps/apple/scripts/ui-test.sh` で、`apps/apple/project.yml` から Xcode のプロジェクトを作り直し、Mac のアプリの XCUITest を走らせる。`sh apps/apple/scripts/ui-test.sh iphone` なら iPhone のアプリを、入っている iPhone のシミュレーターのうちいちばん新しい OS のもの（`IPHONE_SIMULATOR` で名前を選べる）で走らせる。XcodeGen（`brew install xcodegen`）と Xcode が要る。Xcode は `DEVELOPER_DIR` か `xcode-select` のものを使う。iOS のシミュレーターがなければ `xcodebuild -downloadPlatform iOS` で入れる
- 2つ目の引数で流すテストを絞れる。`sh apps/apple/scripts/ui-test.sh iphone PhoneTimerTests/testOneRoundOnTheDeviceRecordStore` ならそのテストだけ、`sh apps/apple/scripts/ui-test.sh mac TimerTests` ならそのクラスのテストだけを流す（`xcodebuild test -only-testing:<テストのターゲット>/<指定>`。Watch も同じ）。合うテストが1つもなければ失敗にする。**手元では関係するテストだけを流し、全部は CI（PR の `ui-test` ラベル）で確かめる**。iPhone の全部は1回で6〜9分かかる
- 3つ目の引数で、絞ったテストを続けて流す回数を選べる。`sh apps/apple/scripts/ui-test.sh watch WatchTimerTests/testPhoneUnreachable 5` なら5回流し、1回でも落ちればそこで止めて失敗にする（`-test-iterations` と `-run-tests-until-failure`）。**UI テストを足したり変えたりしたら、そのテストを続けて3回流してから PR にする**。落ちた理由は、何回目かにかかわらず同じく出す
- Mac と iPhone の UI テストは、待つ・確かめる・やり直すを `apps/apple/UITestSupport/UITestSupport.swift` のヘルパーで書く（両方のテストのターゲットに入れている、Issue #98）。XCUITest の操作は画面に届かずに消えることがある（押したのに効かない、起動しても前に出ない、開ききる前の設定のタブ）ので、画面を変える操作は `tap(_:until:)`（Mac は `click(_:until:)`、キーの操作は `perform(_:until:)`）で、効いたとわかる画面の変化（`ScreenChange`）を待ち、起きなければやり直す。起動は `launch(_:until:)`、文字は `type(_:into:)`（入力欄にカーソルがあるのを確かめてから書く）、文字が変わるのを待つのは `waitFor(_:_:toRead:)`、iPhone の通知の許可は `allowNotificationsWhenTheyInterrupt()`（`setUp` で）と `allowNotificationsIfAsked()`、Mac の設定を開くのは `openSettings(_:tab:)`
- スクリプトが起動したシミュレーターは、テストが通っても落ちても（Ctrl-C で止めても）終わったあとに `xcrun simctl shutdown` で止める。流す前から起動していたものは止めない。起動したままのシミュレーターは1台で100前後のプロセスとメモリを使い続ける。残っていないかは `xcrun simctl list devices booted` で確かめる
- テストで `attachScreenshot(of:named:)`（iPhone は `attachScreenshot(named:)`）を呼ぶと、その名前で `apps/apple/.uitest/screenshots/<名前>.png`（iPhone は `apps/apple/.uitest-iphone/screenshots/`）に書き出す。名前の頭に番号を付けると、その順に並ぶ
- CI の `apple-ui` ジョブも同じスクリプトを Mac と iPhone で走らせ、Web の E2E と同じく画面の一覧（`screenshots-mac.html`・`screenshots-iphone.html`）へのリンクを PR にコメントする。macOS のランナーは長くかかり分数も多く数えられるので、**PR に `ui-test` のラベルを付けたとき**（ラベルがある間は push のたびに）か、Actions の画面から手で走らせたときだけ走る。画面に関わる PR では、ラベルを付けて画面を確かめてから外す
- XCUITest はデバッグのビルドにだけある環境変数でアプリを起動する（`apps/apple/Shared/DeviceLaunch.swift`。Mac の代わりのアカウントは `apps/apple/Nanaichi/LaunchConfiguration.swift`）。`NANAICHI_TIME_SCALE` で時計を速め（15倍なら1ラウンドが2分ほど）、`NANAICHI_TIME_ORIGIN` に同じ起点を渡せば開き直しても時刻が続く。`NANAICHI_DATABASE` はアプリのコンテナの中の記録のファイル名で、`NANAICHI_RESET_DATABASE=1` なら開く前に消す。リリースのビルドはこれらを読まない
- ローカルで XCUITest を走らせるには、Mac の開発者モード（`DevToolsSecurity -enable`）か、最初に出る認証のダイアログでの許可が要る。許可していないと `The test runner failed to initialize for UI testing` で落ちる
- Watch のアプリ（`apps/apple/NanaichiWatch`）も XCUITest で、watchOS のシミュレーターの上で確かめる（e2e は watchOS に対応していない、ADR 0031）。`sh apps/apple/scripts/ui-test.sh watch` で、いちばん小さい画面の Apple Watch SE 3 (40mm) のシミュレーターのうちいちばん新しい OS のもの（`WATCH_SIMULATOR` で名前を選べる）で走らせ、`apps/apple/.uitest-watch/screenshots/` に書き出す。watchOS のシミュレーターがなければ `xcodebuild -downloadPlatform watchOS` で入れる。CI の `apple-ui` ジョブも Watch を走らせ、`screenshots-watch.html` へのリンクを PR にコメントする
- watchOS の XCUITest は iPhone のアプリを一緒に動かせないので、Watch のアプリは `NANAICHI_WATCH_PHONE` で iPhone の代わり（`apps/apple/NanaichiWatch/StubPhoneLink.swift`）につないで起動する。代わりの iPhone は、iPhone のアプリと同じく Watch の頼みをこの端末の記録先（メモリ）のワークフローに通す。`stub` なら届く iPhone、`unreachable` なら届かない iPhone で、`NANAICHI_WATCH_PHONE_STARTS_AFTER` の秒数のあとに iPhone の側でセッションを始めたことにする。`NANAICHI_WATCH_PHONE_STARTED_AGO` の秒数を付けると、Watch で開始したセッションがその秒数だけ前に始まったことになり（そのあとの操作は今の時刻で記録する）、集中の7分を待たずに切り替わりやジャーナル・休憩の画面を確かめられる。`NANAICHI_MANUAL_ADVANCE` は iPhone のアプリと同じく、代わりの iPhone の記録先のフェーズの進め方を手動にする（切り替え待ちの画面を確かめる）。`NANAICHI_WATCH_PHONE_LOSES_ANSWERS` の回数だけ、開始・操作の頼みを記録先に通したうえで答えを返さない（答えが返らなかったときに Watch が今の様子を頼み直すのを確かめる）。振動はシミュレーターで感じられないので、`NANAICHI_WATCH_SHOW_VIBRATIONS` を付けると、鳴らした振動の数（1回の切り替わりで3回）を画面（`watch.vibrations`）に出す（ADR 0033）。実際の WatchConnectivity は、iPhone と Watch のシミュレーターをペア（`xcrun simctl pair`）にして、両方にアプリを入れて確かめる
- 振動など、シミュレーターで確かめられないことは、TestFlight に上げたビルドをオーナーの実機の iPhone と Watch に入れて確かめる（ADR 0032）。上げ方と入れ方は [`SETUP.md`](./SETUP.md) の「iPhone と Watch のアプリを TestFlight で入れる」。Xcode 27 + watchOS 27.2 では実機の Watch が Mac につながらないので、Xcode から直接は入れられない
- ドメインは `apps/apple/NanaichiKit` の `swift test` で確かめる。TS のテストが書き出したゴールデンケース（`fixtures/golden/`）を通す。CI の `apple` ジョブは、Swift のコードかゴールデンケースが変わったときに走る。手元でも、同じ条件で push 時のフックが `swift test` を走らせる（`scripts/swift-test-if-changed.sh`）。Command Line Tools が選ばれていれば `/Applications` のいちばん新しい Xcode を使う
