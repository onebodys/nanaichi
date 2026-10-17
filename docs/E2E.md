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
- chromium がなければ初回に自動でダウンロードされる。CI では先に `pnpm --filter web exec e2e-web install chromium --with-deps` を実行する。
- 結果は `apps/web/.e2e/`（git 管理外）に出る。失敗したテストは `.e2e/results/<テスト>/trace.md` に手順と失敗時の画面が残り、開発サーバーのログは `.e2e/logs/app.log`。
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
- 保存されるのはブラウザの cookie だけで、サーバーの状態（D1 や UserDO のセッション）は持ち越さない。
  ローカルの D1 は実行のあいだで残るので、テストは前の実行の状態に依存しないように書く。

## テスト用のログイン（ADR 0008）

`GET /api/test/sign-in?email=<メールアドレス>` を開くと、Google を通さずにそのユーザーでログインし、
cookie を付けてホーム（`/`）へ戻る。ユーザーがいなければ作る。

- 開くのは、バインディング `TEST_SIGN_IN=enabled` があり、かつ `localhost:5173` / `127.0.0.1:5173` へのリクエストのときだけ。
  それ以外（本番を含む）では 404 になる。`TEST_SIGN_IN` は `wrangler.jsonc` にも `wrangler secret` にも登録しない。
- 許可リスト（`ALLOWED_EMAILS`）に載っていないメールアドレスでは 403 になり、ログインしない。
- E2E では `e2e.config.ts` が `TEST_SIGN_IN=enabled` を渡す。手元の `pnpm dev` では `.dev.vars` に書く（`.dev.vars.example` に入っている）。

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
   agent-browser screenshot home.png            # PR に貼るスクリーンショット
   agent-browser eval 'fetch("/api/session/current").then(r => r.json()).then(JSON.stringify)'  # API の応答も見られる
   ```

   e2e の MCP サーバー（`e2e mcp`、スキルの `references/mcp.md`）を使う場合も、最初に同じ URL を開けばよい。

3. 確かめた手順と結果、スクリーンショットを PR の本文に書く。終わったら開発サーバーを止める。

いまはモデルを設定していないので、`agent.act` などの AI ステップは使えない。
`screen` と `expect` だけの決定的なテストを書く。AI ステップが必要になったら、モデルとその認証を
`e2e.config.ts` の `agents` に足す（スキルの `references/setup.md`）。
