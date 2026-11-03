# セットアップ（Google ログイン / Cloudflare）

nanaichi を動かすために、リポジトリの外で1度だけ必要な作業をまとめる。
コード側の設定は `apps/web/wrangler.jsonc` と `apps/web/.dev.vars` に入っている。

## 1. Google Cloud Console

Google ログインに使う OAuth 2.0 クライアントを作る。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作る
2. 「API とサービス」→「OAuth 同意画面」を設定する
   - ユーザーの種類: 外部
   - 公開ステータスは「テスト」のままでよい。その場合、**テストユーザーに自分の Google アカウントを追加**しておかないとログインできない
3. 「API とサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアント ID」
   - アプリケーションの種類: **ウェブ アプリケーション**
   - 承認済みのリダイレクト URI に次の2つを登録する
     - `http://localhost:5173/api/auth/callback/google`（ローカル開発）
     - `https://nanaichi.app/api/auth/callback/google`（本番）
   - 承認済みの JavaScript 生成元に `https://nanaichi.app` を登録する

   本番の URL は `wrangler.jsonc` の `routes` のカスタムドメイン（`nanaichi.app`）で決まる（ADR 0021）。
   workers.dev の URL へのアクセスは、Worker が `https://nanaichi.app` の同じパスへ転送するので、
   Google には登録しない。ドメインを変えたら、Google 側と `apps/web/src/server/base-url.ts` の
   `CANONICAL_ORIGIN` の両方を直す。

   パスは Better Auth の既定（`/api/auth/callback/google`）。`apps/web/src/server/app.ts` が Hono の
   `basePath("/api")` に `/auth/*` を載せているため、この形になる。

4. 表示された**クライアント ID** と**クライアント シークレット**を控える

> リダイレクト URI が1文字でも違うと `redirect_uri_mismatch` で失敗する。
> ホストを変えたときは Google 側と `apps/web/src/server/base-url.ts` の `CANONICAL_ORIGIN` の両方を直す。

## 2. Cloudflare

`wrangler` にログインしていない状態から始める。

```bash
pnpm cf login
```

> **`wrangler` は必ず `apps/web` で実行する。** `wrangler.jsonc` はそこにしかなく、
> リポジトリ直下で実行すると
> `Required Worker name missing. Please specify the Worker name in your Wrangler configuration file...`
> になる（Worker が無いという意味ではない）。`pnpm cf` は `apps/web` で実行されるので、
> リポジトリのどこから叩いてもよい。

### D1 データベース

```bash
pnpm cf d1 create nanaichi
```

表示された `database_id` を `apps/web/wrangler.jsonc` の `d1_databases[0].database_id` に貼る
（初期値は `00000000-0000-0000-0000-000000000000` のプレースホルダ）。

### secret の登録

4つの値はリポジトリに置かない。本番用に登録する。Worker を先に作る必要はない
（初回の `secret put` で Worker が作られる）。

```bash
pnpm cf secret put BETTER_AUTH_SECRET   # openssl rand -base64 32 などで生成した32文字以上
pnpm cf secret put GOOGLE_CLIENT_ID
pnpm cf secret put GOOGLE_CLIENT_SECRET
pnpm cf secret put ALLOWED_EMAILS       # 例: me@example.com,partner@example.com
```

`ALLOWED_EMAILS` はメールアドレス（PII）なので `vars` ではなく secret にしている。
`wrangler.jsonc` に書くとリポジトリに残ってしまう。

登録できたかは `pnpm cf secret list` で確認できる（値は表示されない）。

### マイグレーションの適用

```bash
pnpm cf d1 migrations apply nanaichi --remote
```

## 3. ローカル開発

```bash
cp apps/web/.dev.vars.example apps/web/.dev.vars   # 値を埋める
pnpm cf d1 migrations apply nanaichi --local
pnpm dev                                           # http://localhost:5173
```

### Orca の worktree で開発するとき

`.dev.vars` は git 管理外なので、Orca が作る worktree には入らない。リポジトリ直下の `orca.yaml` の
Setup Script が、worktree を作るときに元のチェックアウトの `apps/web/.env` を worktree の
`apps/web/.dev.vars` にコピーする（あわせて `vp install` と `vp hooks enable` も走らせる）。

- 元のチェックアウトに `apps/web/.env` を置いておく（中身は `.dev.vars.example` と同じ形）。
  1Password Environments でマウントしたファイル（名前付きパイプ）でもよい。1Password Environments が
  `.env` という名前にしか対応していないため、元では `.env`、worktree では `.dev.vars` という名前にしている。
- `.env` がなければ何もしない。worktree にもう `.dev.vars` があれば上書きしない。
- Orca の設定画面（リポジトリの Hooks）に Setup Script が書いてあると、Orca はそちらだけを使い `orca.yaml` を読まない。
  設定画面の Setup Script は空にしておく（または実行するコマンドの取り方を `orca.yaml` を使うほうにする）。

`apps/web/src/server/base-url.ts` の `DEV_SERVER_HOSTS` は `localhost:5173` を前提にしている。
Vite が別のポートを使うとログインが 400 で弾かれる。

### MCP クライアントをつなぐ

MCP サーバー（ADR 0017）は `/api/mcp` にある。本番なら `https://nanaichi.app/api/mcp`、
ローカルなら `http://localhost:5173/api/mcp`。初めてつなぐとブラウザが開き、nanaichi へのログインと連携の許可を求められる。

```bash
# Claude Code
claude mcp add --transport http nanaichi https://nanaichi.app/api/mcp
# つないだら Claude Code の中で /mcp を開き、nanaichi の Authenticate を選ぶ

# MCP Inspector（ツールを1つずつ試す）
npx @modelcontextprotocol/inspector
# 画面の Add Servers → Add manually で、Transport を streamable-http、URL を上の URL にして Connect
```

MCP の仕様は MCP サーバーの URL を https か loopback（`localhost`・`127.0.0.1`）に限っているので、
portless の `http://*.localhost` では MCP サーバーを出さない（`/api/mcp` は 404）。ローカルで試すときは 5173 番で開く。
5173 番の `localhost` が別のアプリに使われていたら、`PORTLESS_URL=http://127.0.0.1:5173 PORT=5173 HOST=127.0.0.1`
を付けて起動し、`127.0.0.1:5173` で開く。ローカルでは Google のログインが通らないので、先にテスト用のログイン
（docs/E2E.md）でログインしてからつなぐ。

## 4. デプロイ

main への push で GitHub Actions（`.github/workflows/ci.yml`）が次の順に実行する。PR では `check` と `e2e` だけが走り、デプロイはしない。

1. `check` と `e2e` が並んで走る
   - `check`: `vp check` → `vp test` → `vp run -r build`
   - `e2e`: chromium を入れて `pnpm test:e2e`（[`E2E.md`](./E2E.md)）
2. `deploy-secrets`: `check` と `e2e` の両方が通ったときだけ走り、Actions secrets（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）が登録されているかを確かめる
3. `deploy`: `vp run -r build` → 本番 D1 へのマイグレーション（`wrangler d1 migrations apply nanaichi --remote`）→ `wrangler deploy`

secrets が未登録のあいだは `deploy` がスキップされ、CI は緑のままになる。
`deploy-secrets` のログ（と実行結果の画面の注釈）に「Actions secrets（…）が未登録のため、デプロイしません」と出る。

Worker の secret（`BETTER_AUTH_SECRET` など、2章）は Cloudflare 側に残るため、デプロイのたびに登録し直す必要はない。
マイグレーションも適用済みのものは飛ばされるので、手作業で `--remote` を叩く必要はない（初回だけ2章で手で適用していてもよい）。

### API トークンの作成

GitHub Actions が Cloudflare を操作するための API トークンを作る。

1. Cloudflare ダッシュボードの右上のアイコン →「プロフィール」→「API トークン」→「トークンを作成」
2. 「カスタム トークンを作成」で次の権限を付ける（すべて「アカウント」の権限）

   | 権限                                  | レベル   | 使う場面                                                  |
   | ------------------------------------- | -------- | --------------------------------------------------------- |
   | Workers スクリプト（Workers Scripts） | 編集     | `wrangler deploy`（Worker・静的アセット・Durable Object） |
   | D1                                    | 編集     | `wrangler d1 migrations apply --remote`                   |
   | アカウント設定（Account Settings）    | 読み取り | wrangler がアカウントの情報を読む                         |

   「アカウント リソース」は nanaichi を置いているアカウントだけに絞る。
   テンプレート「Cloudflare Workers を編集」を使う場合は、D1 の編集権限が入っていないので足す。

3. 作成後に表示されるトークンを控える（1度しか表示されない）

**アカウント ID** は、ダッシュボードの「Workers & Pages」の右側、または `pnpm cf whoami` で確認できる。

### Actions secrets の登録

GitHub のリポジトリの「Settings」→「Secrets and variables」→「Actions」→「New repository secret」で2つ登録する。

| Name                    | Secret                  |
| ----------------------- | ----------------------- |
| `CLOUDFLARE_API_TOKEN`  | 上で作った API トークン |
| `CLOUDFLARE_ACCOUNT_ID` | アカウント ID           |

`gh` を使うなら次でもよい（値はプロンプトで入力する）。

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

登録したあとの最初の main への push からデプロイされる。すぐに試したいときは、
Actions の画面で main の最新の「CI」を「Re-run all jobs」すればよい。
デプロイできたかは `https://nanaichi.app` を開いて確かめる。`deploy` ジョブのログの末尾には workers.dev の URL も出るが、
そこを開くと `https://nanaichi.app` へ転送される（ADR 0021）。

## 5. E2E テスト

`pnpm test:e2e` で chromium の E2E テストを実行する。詳しくは [`E2E.md`](./E2E.md)。
CI でも PR と main への push のたびに走り、落ちた main はデプロイしない（4章）。
