---
name: session-history
description: セッションの記録（操作イベント・ジャーナル記入・フェーズの進め方の変更）からタイマーの状態を計算し直す部分の有界の網羅検査。apps/web/src/domain/timer-state.ts、session.ts、advance-mode.ts、session-event.ts や、Swift の DeriveTimerState.swift を変えるとき、自動終了・切り替え待ち・同じ時刻の記録の並べ方に触れるとき、記録済みのセッションが「計算できない」で落ちる不具合を調べるときに使う。
---

# セッションの記録の網羅検査

## 何を守っているか

サーバーとこの端末の記録先は、タイマーの状態を保存しない。記録（操作イベント・ジャーナル記入・フェーズの進め方の変更）から毎回計算し直す（ADR 0003）。
`Session.stateAt` は「受け付けた記録は必ず計算できる」と仮定し、計算できなければ例外を投げる。
この仮定が破れると、そのセッションを読むすべての要求が 500 になり、記録を直すまで戻らない。

検査は `apps/web/src/domain/session-history.check.test.ts`。開始から決まった手数までの、受け付けられる記録の並びを**すべて**作る。
1つ記録するたびに、次の約束を確かめる。

| 約束 | 破れたときの害 |
| --- | --- |
| 受け付けた記録は、そのあといつ計算し直しても状態になる | セッションが読めなくなり、すべての要求が 500 になる |
| 完了セットの数は、状態とセットの結末で一致する | タイマーとまとめ・タイムライン・スタッツで数が食い違う |
| 自動終了の時刻より前には自動終了せず、その時刻には終了している | `settleAutoEnd` が同じ過去の時刻に alarm を張り直し、鳴り続ける |
| 動いているフェーズの残り時間は 1 秒以上で、終わる時刻はいまより後 | 0:00 のまま止まって見える |

## 範囲と前提

- **手数**: 開始のあと、既定で 3 回まで記録する（`vp test` で数秒）。`SESSION_HISTORY_DEPTH` で変えられる。4 で約 30 秒、5 で約 20 分かかる。
- **時間の進み**: 記録の間は 0ms（同じミリ秒）、1ms、1分、7分、58分のどれか。フェーズの長さ（集中7分・ジャーナル1分・休憩5分）と自動終了（58分）の境目にちょうど当たる。
- **記録の種類**: 操作 7 種（Pause, Resume, Abort, RestartFocus, SkipBreak, Advance, End）、ジャーナル記入、進め方の変更（すべて自動・すべて手動・集中→ジャーナルだけ手動）。開始の前の進め方も同じ 3 つ。
- **受け付け方**: ワークフローを通さず、ドメインの関数で同じ判断をする。操作は `Session.operate`（`operateSession` と同じ）。記入は終了していないセッションにだけ足す（`writeJournalEntry`）。進め方は、いまと同じなら記録しない（`changeAdvanceMode`）。終了したセッションには何も足さない（`loadOpenSession`）。
- **計算し直す時刻**: 記録した時刻から 0ms・1ms・1分・7分・13分・58分・120分あと。

### 範囲の外

- ワークフロー・SQLite・IndexedDB を通した読み書き。記録の並べ方（同じミリ秒の操作は rowid の順、など）は確かめていない。
- 手数・時間の進みの外の並び。ここで通っても、すべての並びで正しいことの証明ではない。
- Swift の実装。Swift はゴールデンケース（`fixtures/golden/`）で TS と一致させている。この検査で反例が出たら、ゴールデンケースにも足す。
- 端末の記録をアカウントへ取り込む処理（ADR 0020）と、同期メッセージの順序。

## 走らせ方

```sh
cd apps/web
pnpm exec vp test run src/domain/session-history.check.test.ts                         # 既定（手数 3）
SESSION_HISTORY_DEPTH=4 pnpm exec vp test run src/domain/session-history.check.test.ts # 対象のコードを変えたら
```

対象のコードを変えたら、少なくとも手数 4 で走らせる。既定の手数 3 は `vp test` に入っているので、push のたびに走る。

## 反例の読み方

約束が破れると、テストは `violations` に約束ごとの反例を 1 つずつ出す。
浅い手数から順に探すので、反例はその約束を破るいちばん短い並びになる。

```
"property": "受け付けた記録は、そのあといつ計算し直しても状態になる",
"trace": [
  "進め方「FocusToJournal+JournalToFocus+JournalToBreak+BreakToFocus」で開始",
  "+420000ms Advance",
  "+0ms 進め方を「すべて自動」に",
],
"detail": "記録の 0ms 後: 記録済みの操作イベントから状態を計算できない: OperationRejected",
```

`trace` は開始からの手順で、`+Nms` は前の記録からの時間。上の例は、すべて手動で始め、7分後の切り替え待ちで進め、同じミリ秒に進め方をすべて自動に変えた並び。
最初の約束が破れると、ほかの約束も同じ並びで「計算できない」になる。最初の約束から直す。

### 本物の不具合か、検査の誤りか

1. `trace` を `timer-state.test.ts` の `deriveTimerState` のゴールデンケースとして書き、手で書いた期待と比べる。ワークフローがその並びを本当に受け付けるかも確かめる。
2. 並びがワークフローでは起きないもの（例: 終了したセッションへの記入）なら、`record` の受け付け方がワークフローとずれている。検査を直す。
3. 起きる並びなら本物の不具合。約束を弱めたり、その並びを `record` で弾いたりして通さない。コードを直し、`trace` をゴールデンケースとして残す（TS と Swift の両方に効く）。

## 検査が効いていることの確かめ方

約束ごとに、壊した実装で落ちることを確かめてある（同期したコミットの時点）。

| 壊し方（`timer-state.ts`） | 落ちる約束 |
| --- | --- |
| `activitiesBetween` で進め方の変更を操作より先に並べる（以前の実装） | 受け付けた記録は、そのあといつ計算し直しても状態になる |
| `completedSetCountOf` で不成立セットも数える | 完了セットの数は、状態とセットの結末で一致する |
| `autoEndIfInactiveUntil` の `>=` を `>` にする | 自動終了の時刻より前には自動終了せず、その時刻には終了している |
| `advanceTo` の `endsAt > t` を `endsAt >= t` にする | 動いているフェーズの残り時間は 1 秒以上で、終わる時刻はいまより後 |

約束を足したり確かめ方を変えたりしたら、同じように壊した実装で落ちることを確かめる。落ちるのを見ていない検査は何も証明しない。

## 対象のコードと同期したコミット

検査が対象のコードを正しく写していることを、最後に確かめたコミット: **02aa332**

対象:

- `apps/web/src/domain/timer-state.ts`: `deriveTimerState`、`deriveSetOutcomes`、`autoEndDueAt` と、その中の `activitiesBetween`・`applyActivity`・`applyOperation`・`advanceTo`・`autoEndIfInactiveUntil`
- `apps/web/src/domain/session.ts`: `Session.start`・`operate`・`withAdvanceModeChange`・`stateAt`・`setOutcomesAt`・`autoEndDueAt`
- `apps/web/src/domain/advance-mode.ts`: `AdvanceMode.isManual`・`AdvanceModeChange.modeAt`・`relevantSince`
- 受け付け方の写し元: `apps/web/src/workflows/operate-session.ts`・`write-journal-entry.ts`・`change-advance-mode.ts`・`auto-end-session.ts`

対象が変わったか見るには次を走らせる。

```sh
git log --oneline 02aa332..HEAD -- apps/web/src/domain/timer-state.ts apps/web/src/domain/session.ts apps/web/src/domain/advance-mode.ts apps/web/src/workflows/operate-session.ts apps/web/src/workflows/write-journal-entry.ts apps/web/src/workflows/change-advance-mode.ts apps/web/src/workflows/auto-end-session.ts
```

何か出たら、変更を読んで次を確かめる。記録の種類・受け付け方・時間の境目（フェーズの長さ、自動終了までの時間）が検査の `COMMANDS`・`record`・`STEPS_MS` と合っているか。
合っていなければ検査を直し、手数 4 で走らせる。そのあとで、このファイルの同期したコミットを進める。確かめないまま進めない。
