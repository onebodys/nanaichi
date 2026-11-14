---
name: auto-end-alarm
description: UserDO の自動終了の alarm（張る・鳴る・失敗して再試行される・要求と競合する）の TLA+ モデル検査と、本物の UserDO のトレースをモデルに通す検査。apps/web/src/server/user-do.ts の #run・alarm・#applySchedule、apps/web/src/workflows/auto-end-session.ts の settleAutoEnd・loadOpenSession を変えるとき、#run に await を足すとき、セッションが自動終了されないまま残る・早く閉じられる・alarm が鳴り続ける不具合を調べるときに使う。
---

# 自動終了の alarm のモデル検査

## 何を守っているか

UserDO は、閉じていないセッションの自動終了の時刻（`Session.autoEndDueAt`）に alarm を張る。記入・操作・進め方の変更のたびに張り直し、鳴ったら `#run` を通して自動終了を記録する。
alarm の発火・失敗と再試行・要求との競合がどの順に挟まっても、次の約束が守られることを TLC で確かめる。

| 約束（モデルの名前） | 破れたときの害 |
| --- | --- |
| 閉じていないセッションは、要求が来なくなっても、いつか必ず閉じられる（`EventuallyClosed`） | 誰も開かなければ、セッションが閉じられないまま残る。スタッツとタイムラインに出ない |
| 自動で閉じるのは、自動終了の時刻を過ぎてから（`NotClosedBeforeDue`） | 使っている最中のセッションが勝手に終わる |
| alarm を張るなら、いまより後の時刻に張る（`ScheduledInFuture`） | すぐ鳴って同じ過去の時刻に張り直し、alarm が鳴り続ける |
| 閉じていないセッションには、張った alarm か、走る前の `alarm()` がある（`OpenSessionIsWatched`） | `EventuallyClosed` が破れる手前の状態。反例が短く読める |

モデルは `specs/auto-end-alarm/AutoEndAlarm.tla`。各アクションの上のコメントに、写しているコードを書いてある。

| モデルのアクション | コード |
| --- | --- |
| `Run` | `user-do.ts` の `#run`（`transactionSync` の中でワークフローと `settleAutoEnd`、そのあと `#applySchedule`） |
| `LoadOpen`、`ScheduleOf` | `auto-end-session.ts` の `loadOpenSession`、`settleAutoEnd` |
| `Apply` | `start-session.ts`、`operate-session.ts`、`write-journal-entry.ts`、`change-advance-mode.ts` が記録するか断るか |
| `Request` | `#run` を通るすべての RPC（画面・MCP・ジャーナルからの完了） |
| `Fire`、`AlarmSucceeds` | Cloudflare が alarm を鳴らし、`alarm()` が `#run(() => undefined)` を走らせる |
| `AlarmFails` | `alarm()` が例外で終わり、Cloudflare が再試行する |

## 範囲と前提

- **時間**: 整数の刻み。要求は時刻 3 まで、最大 3 回。記入・操作のあとの自動終了の時刻は、その時刻より後の 5 までのどれでもよい（実際は 2 ラウンド後だが、どの値でも成り立つことを確かめる）。`--deep` は要求 5 回・時刻 5 まで・自動終了の時刻 8 まで・失敗 6 回まで（約 9 万状態、十数秒）。
- **ドメイン**: `Session.stateAt` は「自動終了の時刻になったら Ended」とだけ写す。これがコードで成り立つことは `session-history` スキルの網羅検査が確かめている。フェーズや操作の種類はモデルにない。
- **`#run` は割り込まれない**: `transactionSync` のあと、`#applySchedule` の `setAlarm` / `deleteAlarm` の呼び出しまで await がない。JS は1本で動くので、そのあいだにほかの要求も `alarm()` も入らない。だから1つのアクションにしている。間に await を入れると `EventuallyClosed` が破れる（下の表の「トランザクションと setAlarm の間に await を挟む」）。
- **Cloudflare の alarm の振る舞い（仮定）**:
  - 1つの DO に alarm は1つ。`setAlarm` は前の alarm（再試行の待ちも含む）を置き換える。
  - 鳴ってから `alarm()` が走るまでのあいだに要求が割り込みうる。遅れて鳴る場合も、要求と競合する場合も、これで表す。鳴った alarm は消え、`alarm()` は同時に1つしか走らない。
  - `alarm()` が例外で終わると、トランザクションは取り消され、`setAlarm` も呼ばれない。Cloudflare は少し後に再試行し、6 回で諦める。鳴ってから走るまでに要求が alarm を張り直していれば、そちらが残る。
  - `alarm()` が続けて失敗するのは 2 回まで（`--deep` は 6 回まで）。7 回続けて失敗すると Cloudflare が諦め、`EventuallyClosed` は破れる（下の表）。そのときでも、次にセッションを読んだ要求が `loadOpenSession` で閉じる。
- **公平性**: 時間・鳴ること・`alarm()` の実行は止まらない。要求は来なくなってよい。

### 範囲の外

- `Session.stateAt` と `autoEndDueAt` の計算そのもの（`session-history` スキル）。
- この端末の記録先（IndexedDB、ADR 0019）。alarm がなく、読んだときに閉じるだけ。
- SQLite の書き込みと alarm の書き込みが、障害のときに片方だけ残ること。Cloudflare が同じ同期の処理の書き込みをまとめて確定させることを仮定している。
- 時刻を整数の刻みに丸めること。ミリ秒の境目は `session-history` が確かめている。

## 走らせ方

```sh
pnpm tla            # 既定の範囲（数秒）。モデル・壊したモデル・トレースをすべて検査する
pnpm tla --deep     # 実装どおりのモデルを広い範囲で。対象のコードを変えたら走らせる
```

Java 11 以上が要る（macOS なら `brew install openjdk`）。TLC は `check.mjs` が版（1.7.4）と SHA-256 を固定して `node_modules/.cache/tla2tools/` に取ってくる。
push 時のフックと Stop フックは、対象のコードかモデルが main から変わったときだけ走らせる（`scripts/tla-check-if-changed.sh`。Java がなければ飛ばす）。CI の check ジョブは毎回走らせる。

出力は1行に1つの検査で、`ok` か `FAIL`。

```
ok   実装どおりのモデルで NotClosedBeforeDue, ScheduledInFuture, OpenSessionIsWatched, EventuallyClosed が成り立つ（3684 状態）
ok   壊したモデル「要求では張り直さない（開始のときだけ張る）」で EventuallyClosed が落ちる
...
ok   実装のトレース activity-rearms.json（5 歩）をモデルが受け入れる
ok   偽のトレース（終了の操作のあとも alarm が残る）をモデルが受け入れない
```

## 実装のトレースをモデルに通す

`apps/web/src/server/auto-end-trace.workers.test.ts` が、本物の UserDO（Workers ランタイムの上）に要求を送り、`runDurableObjectAlarm` で alarm を鳴らす。
1歩ごとに、閉じていないセッションがあるか・alarm の時刻・自動終了で閉じた数を記録し、`specs/auto-end-alarm/traces/<場面>.json` にファイルのスナップショットとして書き出す。
`check.mjs` はそれを `TraceData.tla` に変え、`TraceAutoEndAlarm.tla` で1歩ずつモデルの同じアクションを動かして、記録と一致するかを見る。

- 実装の振る舞いが変わると、まず `vp test` がスナップショットの食い違いで落ちる。意図した変更なら `vp test -u` で書き出し直し、`pnpm tla` でモデルが受け入れるかを見る。
- 受け入れられなければ、`FAIL` の下に「N 歩目がモデルと一致しない」と、その歩の記録が出る。
- 場面を足したら、`check.mjs` が自動で拾う。トレースが表すのは、要求と alarm が1つずつ順に来る場合だけ。競合と失敗はモデルの網羅検査に任せている。

## 反例の読み方

TLC の出力を `/statechart` スキルで読む。不変条件の違反はいちばん短い手順として、成り立ったときは状態の移り方の図として見られる。
手で読むなら、各状態の `lastRun`（最後の `#run` が何をしたか）・`session`・`alarm`・`handler` を追う。

例: 「トランザクションと setAlarm の間に await を挟む」で `OpenSessionIsWatched` が落ちる手順。

1. セッションのないときに要求が来る（読むだけか、断られる操作）。トランザクションでは「セッションなし」なので、`deleteAlarm` を後回しにする。
2. 開始の要求が来る。セッションを始め、`setAlarm` を後回しにする。
3. 開始の `setAlarm` が先に反映され、そのあと最初の要求の `deleteAlarm` が反映される。
4. セッションは閉じていないのに alarm がない。誰も読みに来なければ、閉じられない。

### 本物の不具合か、モデルの誤りか

1. 反例の手順を、コードで同じ順に起こせるかを確かめる。トランザクションの中で起きることを分けていないか、Cloudflare の仮定（上の「範囲と前提」）に反していないかを見る。
2. 起こせないなら、モデルの誤り。アクションを写し元のコードに合わせて直す。約束を弱めて通さない。
3. 起こせるなら、本物の不具合。コードを直し、その手順をトレースの場面（`auto-end-trace.workers.test.ts`）として足せるなら足す。

## 検査が効いていることの確かめ方

`check.mjs` は毎回、壊したモデルで約束が落ちることも確かめる（モデルの定数 `Bug` で切り替える）。

| 壊し方 | 落ちる約束 |
| --- | --- |
| 要求では張り直さない。開始のときだけ張る（`RearmOnlyOnStart`） | `EventuallyClosed`、`OpenSessionIsWatched` |
| トランザクションと setAlarm の間に await を挟む（`SplitCommit`） | `EventuallyClosed` |
| `autoEndIfInactiveUntil` の `>=` を `>` にする（`OffByOne`） | `ScheduledInFuture` |
| `alarm()` が状態を見ずに閉じる（`CloseOnAlarm`） | `NotClosedBeforeDue` |
| `alarm()` が 7 回続けて失敗する（`MaxFailures = 7`） | `EventuallyClosed` |

トレースの照合も、偽のトレース（終了の操作のあとも alarm が残る）を受け入れないことを毎回確かめる。

本物のコードを壊しても捕まることを、同期したコミットの時点で確かめてある。
`#applySchedule` の `NotScheduled` で `deleteAlarm` を呼ばないようにすると、`vp test` がトレースのスナップショットの食い違いで落ちる。`vp test -u` で書き出し直すと、`pnpm tla` が `end-and-restart.json` と `read-closes-late.json` を受け入れない。

約束や壊し方を足したら、`check.mjs` の `BROKEN` に足し、落ちることを確かめる。落ちるのを見ていない検査は何も証明しない。

## 対象のコードと同期したコミット

モデルが対象のコードを正しく写していることを、最後に確かめたコミット: **88bff2c**

対象:

- `apps/web/src/server/user-do.ts`: `#run`・`#execute`・`alarm`・`#applySchedule`、`#run` を通らずにセッションを読み書きする入口がないこと
- `apps/web/src/workflows/auto-end-session.ts`: `loadOpenSession`・`settleAutoEnd`
- 記録するか断るかの写し元: `apps/web/src/workflows/start-session.ts`・`operate-session.ts`・`write-journal-entry.ts`・`change-advance-mode.ts`
- トレースの記録: `apps/web/src/server/auto-end-trace.workers.test.ts`

対象が変わったか見るには次を走らせる。

```sh
git log --oneline 88bff2c..HEAD -- apps/web/src/server/user-do.ts apps/web/src/workflows/auto-end-session.ts apps/web/src/workflows/start-session.ts apps/web/src/workflows/operate-session.ts apps/web/src/workflows/write-journal-entry.ts apps/web/src/workflows/change-advance-mode.ts apps/web/src/server/auto-end-trace.workers.test.ts
```

何か出たら、変更を読んで次を確かめる。`#run` に await が入っていないか、`#run` を通らない入口が増えていないか、`settleAutoEnd` が返す予定と `#applySchedule` の扱いが `ScheduleOf`・`AlarmAfter` と合っているか、ワークフローが記録するか断るかが `Apply` と合っているか。
合っていなければモデルを直し、`pnpm tla --deep` で走らせる。そのあとで、このファイルの同期したコミットを進める。確かめないまま進めない。
