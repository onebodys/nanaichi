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
     - `https://nanaichi.<あなたのサブドメイン>.workers.dev/api/auth/callback/google`（本番）

   パスは Better Auth の既定（`/api/auth/callback/google`）。`apps/web/src/server/app.ts` が Hono の
   `basePath("/api")` に `/auth/*` を載せているため、この形になる。

4. 表示された**クライアント ID** と**クライアント シークレット**を控える

> リダイレクト URI が1文字でも違うと `redirect_uri_mismatch` で失敗する。
> ホストを変えたときは Google 側と `apps/web/src/server/base-url.ts` の `ALLOWED_HOSTS` の両方を直す。

## 2. Cloudflare

`wrangler` にログインしていない状態から始める。

```bash
cd apps/web
npx wrangler login
```

### D1 データベース

```bash
npx wrangler d1 create nanaichi
```

表示された `database_id` を `apps/web/wrangler.jsonc` の `d1_databases[0].database_id` に貼る
（初期値は `00000000-0000-0000-0000-000000000000` のプレースホルダ）。

### secret の登録

4つの値はリポジトリに置かない。本番用に登録する。

```bash
npx wrangler secret put BETTER_AUTH_SECRET   # openssl rand -base64 32 などで生成した32文字以上
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ALLOWED_EMAILS       # 例: me@example.com,partner@example.com
```

`ALLOWED_EMAILS` はメールアドレス（PII）なので `vars` ではなく secret にしている。
`wrangler.jsonc` に書くとリポジトリに残ってしまう。

### マイグレーションの適用

```bash
npx wrangler d1 migrations apply nanaichi --remote
```

## 3. ローカル開発

```bash
cd apps/web
cp .dev.vars.example .dev.vars   # 値を埋める
npx wrangler d1 migrations apply nanaichi --local
pnpm dev                          # http://localhost:5173
```

`apps/web/src/server/base-url.ts` の `ALLOWED_HOSTS` は `localhost:5173` を前提にしている。
Vite が別のポートを使うとログインが 400 で弾かれる。

## 4. デプロイ

main への push で GitHub Actions が `vp check` → `vp test` → `wrangler deploy` を実行する。
secret は Cloudflare 側に残るため、デプロイのたびに登録し直す必要はない。
