# リポジトリは最初から Vite+ の pnpm monorepo とする

当面は Web だけだが、将来 iOS / watchOS のネイティブアプリを同じリポジトリに追加する。ツールチェーンは ESLint + Prettier ではなく Vite+（`vp`）に統一し、lint は Oxlint、フォーマットは Oxfmt、テストは Vitest を `vp check` / `vp test` から使う。ボイラープレートは `vp create vite:monorepo` と `vp create` で生成する。最初に作るのは `apps/web`（Hono API + SPA の Worker）だけとし、共有する型などが必要になったら `packages/*` に切り出す。ネイティブは `apps/ios` として追加する。
