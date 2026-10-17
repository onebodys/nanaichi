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

いまはモデルを設定していないので、`agent.act` などの AI ステップは使えない。
`screen` と `expect` だけの決定的なテストを書く。AI ステップが必要になったら、モデルとその認証を
`e2e.config.ts` の `agents` に足す（スキルの `references/setup.md`）。
