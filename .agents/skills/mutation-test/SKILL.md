---
name: mutation-test
description: apps/web の domain と workflows のテストが振る舞いを確かめているかを、ミューテーションテスト（@mizchi/mutator）で確かめる。apps/web/src/domain/ か apps/web/src/workflows/ のコードを変えた作業の終わりに、差分だけを回して生き残ったミュータントを直すか等価として記録するときに使う。CI の Step Summary に出た生き残りを片付けるとき、テストが「書き換えても落ちない」かを疑うときにも使う。
---

# ミューテーションテスト（domain / workflows）

## 何を確かめているか

実装をわざと1か所だけ書き換えた版（ミュータント。`>=` を `>` に、戻り値を `undefined` に、分岐を `true` に）でテストを流す。
どのテストも落ちなかったミュータントは**生き残り**で、テストがその振る舞いを確かめていないことを示す。
カバレッジは「通ったか」しか言わない。エージェントがテストを書くこのリポジトリでは、通るだけで何も確かめないテストが紛れ込みやすいので、テストのテストとして回す。

- 範囲は `apps/web/src/domain/` と `apps/web/src/workflows/` のテスト以外の `.ts`（`apps/web/mutator.config.json`）。テストは Node のもの（`vitest.node.config.ts`）だけを使い、`*.workers.test.ts` は使わない。
- 型が通らないミュータントは走らせない（`CompileError`）。`apps/web/tsconfig.json` は参照を並べるだけなので、`MUTATOR_TSCONFIG=tsconfig.app.json` で型チェックの設定を指す。mutator にはこの指定がないため、`patches/@mizchi__mutator-typecheck@0.5.0.patch` で環境変数を読ませている。mutator を上げたら、パッチが当たるか（`pnpm install` が落ちないか）と、型チェックが `typecheck (TypeScript ...)` の行を出すかを見る。
- CI（`.github/workflows/ci.yml` の `mutation`）は PR で変えた行だけを回し、生き残りを Step Summary に出す。生き残りがあっても落とさない。直すのはエージェントとオーナー。

## 1. 差分を回す

```sh
cd apps/web
pnpm -s mutation --since origin/main --reporter agent > .mutator/agent.json
node scripts/mutation-summary.ts .mutator/agent.json   # CI の Step Summary と同じ表
```

- `pnpm -s mutation` は `MUTATOR_TSCONFIG=tsconfig.app.json mutator`。`vp run mutation` は使わない（標準出力にコマンドを書き足し、結果をキャッシュから再生するので、JSON が壊れる）。
- 進み具合は標準エラーに出る。`.mutator/agent.json` には JSON だけが入る。`score` は割合（0.93）。
- 最初の1回はテスト全体のカバレッジを取る（約 20 秒）。2回目からは `.mutator/snapshot.json` を使い、変えた関数とそれを通るテストだけを流し直す。
- 終了コード 4 はミュータントなしでテストが落ちている。先に `vp test` を直す。
- 全体を回すのは `pnpm -s mutation`（`--since` なし）。所要時間は下の「全体の測定」。

## 2. 生き残りを読む

`.mutator/agent.json` の `gaps` が生き残り。1件ごとに `gap`（どこで足りないか）、`file:line`、`original` → `replacement`、囲む関数の本文（`scope.source`）、その行を通るテスト（`coveredBy`）が入る。
`warnings` を先に見る。`uncollectedTest`（変えたテストが走っていない）があれば、生き残りは偽物なので設定を先に直す。

| `gap` | 意味 | 直し方 |
| --- | --- | --- |
| `notReached` | どのテストもその行を通らない | その分岐・早期 return を通る場面のテストを足す |
| `notInfected` | 通るが、書き換えで値が変わる入力がない | 境界値を足す。`>` → `>=` なら、ちょうど等しい時刻の場面 |
| `notDetected` | 通って値も変わるが、どのテストも落ちない | 違いが出る結果を確かめる。`toBeTruthy` を `toBe` に、部分一致を `toEqual` にする |

関数ごと（`scope.id`）にまとめて片付ける。`coveredBy` のテストファイルを読み、同じファイルに、同じ書き方で足す。

## 3. 直す

- テスト名は、ミュータントではなく場面で書く（AGENTS.md §1。例: `進め方の変更が始めた時刻と同じなら自動終了の時刻を延ばさない`）。`GLOSSARY.md` の用語を使う。
- 呼び出し側から見える振る舞いを確かめる。内部の状態や呼び出しの順番を確かめてミュータントを殺さない（リファクタで壊れる）。
- ミュータントを殺すために実装を変えない。実装の不具合を見つけたら、作業を止めて Issue にする。
- 書き換えのあと、そのミュータントだけを確かめ直す。数秒で終わる。

```sh
pnpm -s mutation --only <key> --reporter agent
```

`counts` に `Killed` が出て `gaps` から消えれば片付いている。残るなら、入力か確かめ方が違いを見分けていない。同じ種類のテストを足し続けない。

## 4. 等価ミュータントを記録する

どんな入力でも元と見分けられない書き換え（等価ミュータント）は、テストで殺さない。理由をつけて記録する。

```sh
pnpm -s mutation accept <key> --reason "equivalent: <どの入力でも見分けられない理由>"
```

`apps/web/mutator.accepted.json` に書かれる。コミットして、コードと同じくレビューを受ける。
理由は具体的に書く（例: 「`kind` が Ended のときは前の分岐で return しているので、この比較はいつも false」）。等価か確信がなければ記録せず、報告に「未確認」として書く。
あとの実行で、記録したものがテストで殺せるようになった（`acceptance.killed`）か、もうない（`acceptance.stale`）と出たら、ファイルから消す。

## 5. 報告する

作業の終わりに、PR の本文に次を書く。

- 回したコマンドとスコア（差分の `counts`）
- 殺した生き残りと、足した・直したテスト
- 等価として記録したものと理由
- 片付けなかったもの（別の Issue にしたならその番号）

## 全体の測定

（Issue #60 で測った。数字は PR を見る）
