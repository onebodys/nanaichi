# リポジトリは最初から pnpm monorepo とする

当面は Web だけだが、将来 iOS / watchOS のネイティブアプリを同じリポジトリに追加する。最初に作るのは `apps/web`（Hono API + SPA の Worker）だけとし、共有する型などが必要になったら `packages/*` に切り出す。ネイティブは `apps/ios` として追加する。
