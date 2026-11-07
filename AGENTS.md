# AGENTS.md

nanaichi の開発でエージェントが守る価値観と規約。
ドメインの用語は [`GLOSSARY.md`](./GLOSSARY.md)、仕様は [`docs/PRODUCT.md`](./docs/PRODUCT.md)、覆しにくい判断は [`docs/adr/`](./docs/adr/) を正とする。

サーバー側 TypeScript の設計（判別可能な union による状態の表現、純粋な状態遷移、Result、境界でのスキーマ検証、PII の保護）は **kamae スキル**（`.agents/skills/kamae`）に従う。
kamae は「推奨であって厳格なルールではない」と書いているが、このリポジトリでは**原則として守る**。外れる場合はコメントで理由を書く。
以下は kamae がカバーしていない部分と、このプロジェクト固有の決定。

## 1. 最優先: お互いが検証できる状態にする

オーナーはコードを網羅的にはレビューしない。確認するのは**最終的な出力**と、**ユースケース単位の妥当性**。
したがって「動いた」と主張するだけでなく、オーナーとエージェントの双方が検証できる証拠を残すことを、あらゆる作業で最優先にする。

- **エージェント自身の検証**: 作業を終える前に必ず `vp check` と `vp test` を通す。画面に関わる変更は実際にブラウザで動かして確認する（ログイン済みの画面の開き方は [`docs/E2E.md`](./docs/E2E.md) の「ワーカーが画面を確かめる」）。通っていないものを「完了」と報告しない。
- **オーナーが検証できる形で報告する**: PR の本文に以下を必ず書く。
  - 何ができるようになったか（ユースケースの言葉で、`GLOSSARY.md` の用語を使う）
  - エージェントがどう検証したか（実行したコマンドと結果、画面ならスクリーンショット）
  - オーナーが確かめる手順（どの画面で何をすると何が起きるか）
  - 検証できなかったこと・未確認のこと
- **テストを仕様として読めるようにする**: ドメインとワークフローのテスト名は日本語で、`GLOSSARY.md` の用語を使った場面として書く（例: `集中中に中断すると不成立セットになり待機に戻る`）。テスト一覧がそのまま仕様の確認リストになるようにする。
- **認証が絡む API はローカルの結合テストで確かめる**: `apps/web/src/server/auth-test-harness.ts` が miniflare の D1 と Better Auth の `testUtils` でログイン済みのセッションを作る。Cloudflare や Google に繋がずに `vp test` だけで検証できるので、`/api/*` にエンドポイントを足したら未ログイン（401）とログイン済みの振る舞いをこれでテストする。
  - UserDO（Durable Object）を通る API は Node では動かせないので、`*.workers.test.ts` に書き、`@cloudflare/vitest-plugin` で Workers ランタイムの上で動かす（`vitest.workers.config.ts`、土台は `apps/web/src/server/workers-test-harness.ts`）。時刻は `vi.setSystemTime` で進め、alarm は `runDurableObjectAlarm` で鳴らす。
- **Issue の完了条件を満たしたことを示す**: PR は対応する Issue の完了条件を1つずつ、どう満たしたかに対応づける。
- **flaky はその場で Issue にする**: テストがたまに落ちたら、作業と関係がなくても「無関係だから流す」で終わらせない。流し直して通っても、リトライで通っても同じ。Issue にはテスト名、落ちたときの出力、再現の頻度を書く。CI でリトライで通ったテストは、Step Summary の見出しに flaky の件数が出て、折りたたみの中に落ちたステップが出る（`docs/E2E.md`）。

## 2. ユースケースは ROP で読めるように書く

オーナーはユースケース単位で問題がないかを確認する。そのためユースケース（ワークフロー）は、DMMF の Railway Oriented Programming として**上から下へ読めば流れがわかる**形にする。

- Result 型は `@praha/byethrow` を使う（kamae の `result-libraries/byethrow.md`）。自前の Result 型は作らない。
- 1つのワークフローは「入力の検証 → 必要な値の読み込み → 純粋な判断 → 永続化」を `Result.pipe` / `Result.do` / `Result.bind` で組み立てる。各ステップは名前のついた小さな関数に切り出す。
- 想定内の失敗（中断できないフェーズでの中断、セッション外での記入など）はワークフローごとのエラー union として Result で返す。例外は想定外の障害と不変条件違反だけ。
- byethrow の Result の判別子は `type`（`"Success"` / `"Failure"`）だが、これはライブラリの都合として受け入れる。**自分で定義する型の判別子は必ず `kind`**。

## 3. Functional Core / Imperative Shell と依存の方向

- **ドメインは純粋**にする。ドメインのコードでは I/O、`Date.now()` / `new Date()`、`crypto.randomUUID()`、`Math.random()` を使わない。時刻と ID は引数で受け取る。
- **依存は外側から内側への一方向**。ドメインはワークフローやアダプタ、フレームワーク（Hono、React、Cloudflare の型、Better Auth、DB）を import しない。
  - この制約は Oxlint の `no-restricted-imports` などで**機械的に検査**できるようにする（検証可能性のため）。
- ワークフローが必要とする読み書きの契約（resolver / store）はドメイン側に、概念の隣に置く（kamae の方針どおり。`ports/` ディレクトリは作らない）。
- **不要なレイヤーは作らない**。DDD をやりたいわけではない。集約・リポジトリ・アプリケーションサービスなどの層を形式のために増やさない。

### ディレクトリ構成（`apps/web`）

```
apps/web/src/
  domain/      純粋なドメイン（型・状態遷移・判断・読み書きの契約）。サーバーとブラウザの両方から使う
  workflows/   ユースケース。I/O を端に置き、domain の純粋関数を ROP でつなぐ（サーバー側）
  server/      Imperative Shell: Hono のルート、UserDO、D1 / DO SQLite のアダプタ、Better Auth、組み立て
  client/      Imperative Shell: React の画面、通信、音・通知・Wake Lock
  device/      Imperative Shell: この端末の記録先。UserDO と同じワークフローを IndexedDB の記録につなぐ（ADR 0019）
```

- `domain/` は他のどのディレクトリも import しない。
- `workflows/` は `domain/` だけを import する。
- `device/` は `domain/` と `workflows/` だけを import する。`client/` は `device/index.ts` だけを import してよい。
- `server/` と `client/` は互いを import しない（共有するものは `domain/` に置く）。

## 4. 型で取りうる状態を狭める

kamae の「状態ごとに型を分ける」を、このプロジェクトでは徹底する。

- optional / nullable なプロパティで状態を表さない。状態ごとに型を定義し、判別可能な union にする（例: タイマーは `Idle | Focus | Journal | Break | Ended` のように分け、「休憩中はセット番号がない」を `setNumber?: number` ではなく型の違いで表す）。
- 判別可能な union の分岐は `kind` の `switch` で書き、すべての `kind` を `case` に並べる。同じ扱いのものは `case` を続けて書き、`default` は書かない。網羅性は Oxlint の `typescript/switch-exhaustiveness-check` で検査する。パターンマッチのライブラリ（ts-pattern など）は使わない（ADR 0022）。
- 境界（API の入力、DB の行、WebSocket のメッセージ）で受け取った値はスキーマで検証し、その場で状態ごとの型に変換する。DB の行の nullable な列をドメインに持ち込まない。
- 型アサーション（`as`）は使わない。`as const` と `as const satisfies Type` のみ可。

### 境界での検証と PII

- バリデーションライブラリは **valibot**（kamae の `validation-libraries/valibot.md`）。ドメインのコードはブラウザにも配信するため、tree-shaking で小さく済むものを選んだ。
- スキーマの検証結果は、kamae の `schemaResult`（Standard Schema → byethrow の Result）を1つだけ定義して使い回す。
- **メールアドレスとジャーナル記入の本文は PII** として `Sensitive<T>` で包む。境界のスキーマで自動的に包まれるようにし、ログやエラーに本文が出ないようにする。

## 5. ブラウザ側（kamae の対象外）

kamae はフロントエンドを対象外にしているため、ここで補う。

- タイマーの状態計算など、ドメインの判断は `domain/` の関数を使う。React コンポーネントの中にドメインの判断を書かない。
- コンポーネントは「状態を受け取って描画し、操作をワークフローの呼び出しに変換する」だけにする。
- サーバーから受け取った値（API のレスポンス、WebSocket のメッセージ）もスキーマで検証してから使う。
- shadcn/ui のコンポーネントは Base UI 版（`components.json` の style が `base-vega`）を `shadcn add` で入れる。Radix 版は使わない。CLI は `cn` を npm の `cn` パッケージから import し、依存にも足してしまうので、import は `@/client/lib/utils` に直し、`cn` パッケージは入れない。
- 押せるもの（ボタン、切り替え）はカーソルを指の形（`cursor: pointer`）にそろえる。Tailwind v4 の既定（ボタンは矢印）には従わず、`client/index.css` の base でボタンに付けている。ボタン以外の要素で押せるものを作ったら `cursor-pointer` を付ける。

### API のレスポンスの検証（ADR 0009）

- レスポンスのスキーマ（valibot）は `domain/` に、レスポンスが表す型の隣に `<型名>JsonSchema` として置く（例: `domain/session.ts` の `SessionSnapshotJsonSchema`、`domain/api-error.ts` の `ApiErrorBodyJsonSchema`）。JSON にした値（時刻は ISO 8601 の文字列）を検証してドメインの型（時刻は `Date`）に戻す。出力の型は `v.GenericSchema<unknown, ドメインの型>` で注釈する。
- サーバーはドメインの型をそのまま `c.json` で返す。エラーの本文は `satisfies ApiErrorBody` で種類を縛る。
- 画面は `fetch` を直接呼ばず、`client/api.ts` の通信層（fetch → スキーマ検証 → byethrow の Result）を通す。失敗は `NetworkError` / `ApiRejected` / `UnexpectedResponse` で、画面は `kind` で扱いを決める。
- エンドポイントを足したら、スキーマを `domain/` に、関数を `client/api.ts` に足し、「実際の応答がスキーマに合う」ことを結合テスト（`*.workers.test.ts` など）で、「通信層が Result で返す」ことを `client/api.test.ts` で確かめる。

## 6. 用語とコードの対応

- コード上の識別子は `GLOSSARY.md` の英語名を使う（Focus, Journal, Break, Phase, Idle, Set, Round, Session, SessionEvent, Start, Pause, Resume, Abort, RestartFocus, SkipBreak, Advance, End, AutoEnd, CompletedSet, AbortedSet, Snapshot, JournalEntry, Timeline, PhaseChange, AdvanceMode, AwaitingAdvance, ClockOffset, SyncMessage）。
- `_Avoid_` に挙げた言い換えはコードでもドキュメントでも使わない。
- 新しい概念が出てきたら、コードを書く前に `GLOSSARY.md` を更新する（domain-modeling スキル）。

## 7. ツールと作業の進め方

- ツールチェーンは Vite+（`vp`）。`vp check`（Oxlint / Oxfmt / 型チェック）と `vp test`（Vitest）を使う。ESLint / Prettier は入れない。
- 未使用のファイル・export・依存は knip（`pnpm knip`、設定は `knip.config.ts`）で検出する。Vite+ プラグインが各ワークスペースの `vite.config.ts` を読む。誤検知は設定で除外し、理由をコメントで書く。
- チェックはフックで自動化している。`pnpm install` で Git フックが入り、コミット時は `vp staged`、push 時は ADR の番号の検査（`scripts/check-adr-numbers.sh`）と `vp check` と `vp test` と `knip` が走る。knip はリポジトリ全体の参照関係を見るため、ステージしたファイル単位で走るコミット時ではなく push 時に入れている。Claude Code は作業を終える前に Stop フック（`.claude/hooks/verify-before-stop.sh`）で同じチェックを走らせ、落ちていれば終えられない。フックを `--no-verify` などで飛ばさない。
- 依存は正確なバージョンで固定し（`pnpm-workspace.yaml` の `savePrefix: ""`）、GitHub Actions は `.github/workflows/actions.lock` でコミットに固定している。更新は Dependabot の PR で受け取る（`.github/dependabot.yml`）。ワークフローに Action を足したり版を変えたりしたら `gh actions-lock`（`gh extension install github/gh-actions-lock`）で lockfile を更新する。更新しないと CI がジョブを始める前に `startup_failure` で落ちる。
- CI はドキュメントだけの変更（Markdown、`docs/`、`.agents/`、`.claude/`）ならテスト・ビルド・E2E を飛ばし、ADR の番号の検査と `vp check` だけを走らせる。
- Issue ごとにブランチを切り、PR で `Closes #N` を書く。main に直接 push しない。
- ドキュメント、コードコメント、PR の本文、テスト名は日本語。識別子とコミットメッセージは英語。
- 覆しにくい判断をしたら `docs/adr/` に ADR を書く（domain-modeling スキルの基準に従う）。
- ADR の番号は、並行するワークツリーで同じ番号を取りやすい。PR をマージする直前に `git fetch origin main` で main の最大番号を見て、重なっていれば次の番号へ振り直す（ファイル名と、その ADR への参照）。
