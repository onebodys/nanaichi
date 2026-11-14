---
name: session-sync
description: 画面のセッションの同期（HTTP の応答と WebSocket の同期メッセージが入れ替わって届く、ADR 0012）を TLA+ のモデルで網羅検査する。apps/web/src/client/snapshot-arrival.ts、use-session-timer.ts、operation-overlap.ts、sync-connection.ts、use-sync.ts、domain/session.ts の SessionSnapshot.isOlder、server/user-do.ts の #run・#execute・#broadcast・fetch を変えるとき、同期メッセージや読み込み直しの順序に触れるとき、画面のタイマーが古い状態に戻る・追いつかない不具合を調べるときに使う。
---

# 画面のセッションの同期のモデル検査

## 何を守っているか

UserDO が記録を変えるたびに、同じ変更が HTTP の応答と同期メッセージ（`SessionChanged`）の両方で画面に届く。届く順は入れ替わり、同じものが2回届き、WebSocket は切れて繋ぎ直す（ADR 0012）。
画面は `SessionSnapshot.isOlder` でサーバーの時刻が古いスナップショットを捨て、繋がるたびに読み込み直す。
どの順で届いても画面が正しいかは届く順の組み合わせで決まり、テストでは代表的な順しか試せないので、TLA+ のモデルで全部の並びを調べる。

| 性質（`SessionSync.tla`） | 一文で | 破れたときの害 |
| --- | --- | --- |
| `NoTimeRollback` | どの画面も、一度見せたスナップショットよりサーバーの時刻が前のものに戻らない | 新しい操作が古い状態で上書きされて見える |
| `NoChangeRollback` | どの画面も、一度見せた変更より前の記録に戻らない | 同上（利用者から見た害そのもの） |
| `SameTimeSameChange` | 同じサーバーの時刻のスナップショットは同じ変更である | `isOlder` の前提が崩れ、上の2つが破れうる |
| `StaysLoaded` | 一度読み込めた画面は読み込めたまま | 上の2つを1歩ずつ比べてよい根拠がなくなる |
| `EventuallyConverged` | 変更が止まれば、すべての画面はいつか最新のスナップショットにそろう | 画面が古いまま、次の変更か繋ぎ直しまで追いつかない |

## いま分かっていること

実装のままで成り立たないものがある。モデルと、本物の UserDO を動かしたトレースの両方で確かめてある。

- **#51**: 同じミリ秒に処理された読み込みと別の変更で、画面が巻き戻る（`stall-rollback`、`stall-one-screen`）。Workers の時計は I/O まで進まないので、同時に届いた要求は同じミリ秒になりうる。`SameTimeSameChange` が破れ、`NoChangeRollback` も破れる
- **#52**: 読み込み中に届いた同期メッセージを捨てるので、変更より前の読み込みだけが届いた画面は古いまま（`liveness`）。通信が失われなくても起きる
- **#53**: HTTP の応答が失われると、次の変更か繋ぎ直しまで古いまま（`liveness-hold-sync-losses`）
- **#54**: 操作と重なった読み込みを捨てるので、その間に別の端末の変更があり同期メッセージを受け取れていないと、古いまま（`--deep` の `liveness-hold-sync`。書き込み 2 の手数で出る）。通信が失われなくても起きる

時計が要求ごとに進む（同じミリ秒に2つの要求がない）なら、安全性は通信が失われても成り立つ（`safety`、`safety-faults`）。
画面が1つで操作だけなら、時計が止まっても巻き戻らない。`operation-overlap.ts` が効いている（`stall-one-screen-ops`）。

これらを直したら、`check.mjs` の期待（`expect`）を pass に変え、直し方をモデルに写す。直し方の候補 `HoldSyncWhileLoading`（#52）はモデルの `Fixes` にあり、実装に入ったら `Fixes` から外して `ReceiveSync` をその動きにする。
`HoldSyncWhileLoading` だけでは、既定の手数（書き込み 1）で活性が成り立つが、`--deep`（書き込み 2）では #54 のために成り立たない。

## 範囲と前提

- **画面**: 2つ（`stall-one-screen*` は1つ）。各画面は同期の WebSocket を1本張る
- **手数**（既定 / `--deep`）:
  - 安全性: 書き込み 2 / 3、通信の失敗なし
  - 安全性（通信の失敗あり、`safety-faults`）: 書き込み 1、HTTP の喪失 1、WebSocket の切断 1（`--deep` でも同じ。書き込み 2 は 1 時間で終わらなかった）
  - 活性: 書き込み 1 / 2、WebSocket の切断 1（`liveness-hold-sync-losses` は HTTP の喪失 1、切断 0）
  - 時計が止まる場合: 時刻の上限 6 / 8
- **時計**: 2つの見方で調べる。`ClockStalls = FALSE` は「UserDO が要求を処理するたびに時計が進む」。`ClockStalls = TRUE` は「時計は実時間で進み、同時に届いた要求は同じミリ秒に処理されうる。要求は送ってから 1ms 以上あとに届く」
- **書き込み**: 開始・操作（`Operate`。断られることがある）と、記入・進め方の変更（`Write`。応答はスナップショットではなく、成功したら読み込み直す）
- **通信**: HTTP の要求と応答はどの順でも届き、失われうる（画面には `Unreachable`）。WebSocket は1本の中では順に届き、切れると届いていないメッセージは失われる
- **時刻と変更**: スナップショットは `[t, v]`。`t` はサーバーの時刻の大小だけを残した整数、`v` は何番目の変更までを含むか（実装にはない、検査のための値）

### 範囲の外

- 自動終了（alarm）。同期メッセージを送らず、画面は時刻から自分で計算する（ADR 0012）。終了して「セッションなし」に戻る並びも、`v` が減らない前提なので扱わない
- 記入・タグ・タスクなど、タイマーのスナップショット以外の同期（記入は ID で置き換えるので、重複しても困らない）
- 時計のずれ（`ClockOffset`）と、画面の中のタイマーの計算
- React の配線（`use-session-timer.ts` がいつ何を呼ぶか）はモデルとトレースのテストに手で写している。写し間違いは検査できない
- 手数の外の並び。ここで通っても、すべての並びで正しいことの証明ではない

## 走らせ方

```sh
node formal/session-sync/check.mjs            # 既定（全部で2分ほど）
node formal/session-sync/check.mjs --deep     # 対象のコードを変えたら（1時間ほど。状態の数は億を超える）
node formal/session-sync/check.mjs --only stall-rollback
node formal/session-sync/check.mjs --trace    # 実装のトレースをモデルに通す（10秒ほど）
```

Java は PATH にあればそれを使い、なければ `mise exec java@temurin-21` を使う。TLC（tla2tools.jar 1.7.4）は `check.mjs` がハッシュを確かめて `~/.cache/nanaichi-tla` に取ってくる。
TLC の検査は `vp test` にも push のフックにも入っていないので、対象のコードを変えたら自分で走らせる。
トレースのテスト（`session-sync-trace.workers.test.ts`）は `vp test` に入っている。#51・#52 の並びで画面が古いままになることを確かめているので、直すとそのテストが落ちる。期待を直したあとの振る舞いに変え、`--trace` も走らせる。

出力は検査ごとに1行。

```
ok   safety                         期待: pass                 結果: pass                 1812905 states, 16s
ok   stall-rollback                 期待: NoChangeRollback     結果: NoChangeRollback     85554 states, 2s
```

`ok` は期待どおり（通るはずのものが通り、破れるはずのものが破れた）。`NG` が1つでもあれば終了コードは 1。
最後の行に TLC の出力を置いた一時ディレクトリが出る。`<検査の名前>.out` が TLC の出力そのもの。
TLC の状態のファイル（`--deep` では 10 GB を超える）は検査ごとに消す。`.out` は残るので、要らなくなったらディレクトリごと消す。

## 結果の読み方

TLC の結果は `/statechart` スキルで読む。破れた性質は、いちばん短い並びを言葉で示してくれる。通った検査からは、状態の移り方の図を描ける。

反例は、画面ごとの `loading`・`shown`（見せているスナップショット）、`httpReq`・`httpRes`（届いていない要求と応答）、`wsq`（届いていない同期メッセージ）、UserDO の `clock`・`ver` の移り変わり。
アクションの名前はコードに対応する（`SessionSync.tla` の各アクションの上のコメントにファイルと関数がある）。たとえば `ServeLoad` は `GET /api/session/current`、`ReceiveSync` は `timer.receive`、`Opened` は `onConnected` の読み込み直し。

### 本物の不具合か、モデルの誤りか

1. 反例の並びを、`apps/web/src/testing/session-sync-trace.workers.test.ts` のシナリオとして書く。本物の UserDO と画面の反映で同じ結果になるか確かめ、`--trace` でモデルにも通す
2. トレースがモデルで通らない（`NG trace-N  k 手目をモデルで起こせない`）なら、モデルが実装とずれている。k 手目のアクションと、そのときの値を実装と見比べてモデルを直す
3. 実装で同じ結果になるなら本物の不具合。性質を弱めたり、その並びをモデルから外したりして通さない。Issue にし、`check.mjs` の期待をその性質が破れる（`expect`）にして、ここの「いま分かっていること」に書く
4. 並びが現実には起きない（たとえば、順に送った2つの要求が同じミリ秒に処理される）なら、モデルの前提が緩すぎる。前提を直し、なぜ起きないかをコメントに書く

## 検査が効いていることの確かめ方

性質ごとに、壊した実装（`Mutation`）で落ちることを確かめてある（同期したコミットの時点）。`check.mjs` が毎回走らせる。

| 壊し方 | 対応するコード | 落ちる性質 |
| --- | --- | --- |
| `IsOlderReversed`: `isOlder` の比較を逆にする | `domain/session.ts` の `SessionSnapshot.isOlder` | `NoTimeRollback` |
| `ChangeKeepsClock`: 記録を変えても時計を進めない | `server/user-do.ts` の `#run`（`new Date()`） | `SameTimeSameChange` |
| `NoOverlapCheck`: 操作と重なった読み込みも反映する | `client/snapshot-arrival.ts` の `applyLoaded`、`operation-overlap.ts` | `NoChangeRollback`（画面1つ、時計が止まる） |
| `NoRefreshOnConnect`: 繋がっても読み込み直さない | `client/use-sync.ts` の `onConnected` | `EventuallyConverged`（`HoldSyncWhileLoading` つき） |

トレースの照合も、壊した実装で落ちることを確かめてある。`applySynced` が読み込み中のメッセージも反映するように変えると、`--trace` が3つ目のトレースの 10 手目（読み込み中の `ReceiveSync`）で `NG` になる。
性質や壊し方を足したら、同じように落ちることを確かめる。落ちるのを見ていない検査は何も証明しない。

## 実装のトレース

`session-sync-trace.workers.test.ts` は Workers ランタイムで本物の UserDO（HTTP と WebSocket）を動かし、画面の側は `client/snapshot-arrival.ts` と `client/operation-overlap.ts` を本物で動かす。どの応答・メッセージをいつ画面に渡すかはテストが決め、時刻は `vi.setSystemTime` で決める。
1手ごとにモデルのアクションの名前と値を `task.meta.sessionSyncTrace` に残し、`check.mjs --trace` が Vitest の JSON の報告から取り出して `SessionSyncTrace.tla` に通す。
`v` はセッションの操作イベントの数で数えるので、トレースのシナリオでは開始と操作だけを送り、終了しない。

シナリオを足すときは、手を記録する関数（`recorder` の `serveLoad`・`receiveSync` など）を使う。モデルにないアクション（記入など）を足すなら、先に `SessionSyncTrace.tla` の `Match` に足す。

## 対象のコードと同期したコミット

モデルが対象のコードを正しく写していることを、最後に確かめたコミット: **06207fb**

対象:

- `apps/web/src/domain/session.ts`: `SessionSnapshot.isOlder`、`Session.snapshot`
- `apps/web/src/client/snapshot-arrival.ts`: `applyReceived`・`applyLoaded`・`applyLoadFailed`・`applySynced`
- `apps/web/src/client/use-session-timer.ts`: `load`・`send`・`reload`・`refresh`・`receive`（どれをいつ呼ぶか）
- `apps/web/src/client/operation-overlap.ts`: `createOperationTracker`
- `apps/web/src/client/sync-connection.ts`: `connectSync`（繋ぎ直し、`isCurrent`）
- `apps/web/src/client/use-sync.ts`: `onConnected` と `deliver` の `SessionChanged`
- `apps/web/src/client/home-page.tsx`: 記入・進め方の変更のあとの `timer.refresh()`
- `apps/web/src/server/user-do.ts`: `fetch`（`acceptWebSocket`）・`#run`・`#execute`・`#broadcast`
- `apps/web/src/workflows/user-commands.ts`: どの書き込みが `SessionChanged` を送るか

対象が変わったか見るには次を走らせる。

```sh
git log --oneline 06207fb..HEAD -- apps/web/src/domain/session.ts apps/web/src/client/snapshot-arrival.ts apps/web/src/client/use-session-timer.ts apps/web/src/client/operation-overlap.ts apps/web/src/client/sync-connection.ts apps/web/src/client/use-sync.ts apps/web/src/client/home-page.tsx apps/web/src/server/user-do.ts apps/web/src/workflows/user-commands.ts
```

何か出たら、変更を読んで次を確かめる。届いたスナップショットの扱い、読み込み直すきっかけ、同期メッセージを送る相手と順序、時刻の読み方が、`SessionSync.tla` のアクションと合っているか。
合っていなければモデルとトレースのテストを直し、`--deep` と `--trace` を走らせる。そのあとで、このファイルの同期したコミットを進める。確かめないまま進めない。
