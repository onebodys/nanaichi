# Web は TanStack Start ではなく、1つの Worker に Hono API と Vite React SPA を同居させる

最終ゴールは iPhone / Apple Watch のネイティブアプリなので、バックエンドはネイティブからも叩ける公開 API である必要がある。TanStack Start のサーバー関数はフロント専用の RPC でこの用途に合わず、ログイン後に使うタイマーアプリでは SSR の恩恵もほとんどない。そのため Hono（`/api/*`、Better Auth、ユーザーごとの DO への振り分け）と、Workers Static Assets で配信する Vite + React + TanStack Router の SPA を1つの Worker に置き、型は Hono RPC で共有する。
