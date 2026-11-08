# Apple の端末は Swift・SwiftUI で作り、それ以外は PWA で受ける

iPhone・Apple Watch・Mac のネイティブアプリは Swift・SwiftUI で作り、ドメインを1つの Swift Package にして共有する。Windows・Linux・Android は、ネイティブアプリを作らず、当面は今の Web を PWA として使ってもらう。最初に作るのは iPhone + Apple Watch（Issue #65）としていたが、Mac から作ることにした（ADR 0028）。

watchOS の画面は SwiftUI でしか作れない。React Native や Flutter を選んでも、Watch の部分は Swift で書くことになり、ドメインも Swift に移すことになる。どの道を選んでも Swift のドメインを持つなら、iPhone・Watch・Mac で共有したほうが Mac をネイティブにする追加コストは小さい。また nanaichi の価値に効くのは、ネイティブでしか得られないものばかりである。Watch の振動とバックグラウンドで動き続けるための拡張ランタイムセッション、端末の中で文字にする音声入力（#33）、フェーズの切り替わりのローカル通知での予約（ADR 0003 で時刻とイベントから計算するので、サーバーに繋がらなくても予約できる）、Live Activity とメニューバー常駐。デザインも OS 間で揃えず、それぞれのプラットフォームの流儀に合わせたい。

Windows のネイティブアプリは、オーナーの手元に Windows がなく、作っても検証できる人がいない。検証できないものは出さない（AGENTS.md の最優先事項）ので作らない。PWA なら今のコードがそのまま動く。

## Consequences

- ドメインのロジック（タイマー状態の計算など）を TS と Swift の2つで持つ。2つが同じ振る舞いをすることは、TS のテストケースを JSON の入力と期待する出力（ゴールデンケース）として書き出し、Swift 側でも同じケースを通すことで確かめる。片方だけを変えると、もう片方のテストが落ちるようにする。
- 初版の Watch は iPhone を経由した同期で動けばよい。Watch が iPhone もネットもない状態で単体で動くこと（オフラインでのイベントのマージ）は、そのあとに作る。
- 作る順番は、ドメインの Swift Package（ゴールデンケースで TS と一致）→ iPhone + Watch → Mac（メニューバー常駐）→ Watch 単体での動作、としていた。ADR 0028 で、Mac を iPhone + Watch より先にした。
- ネイティブは Bearer トークンで認証し、App Store の審査に向けて Sign in with Apple を併設する見込み。Sign in with Apple は App Store に出すときに足す（ADR 0028）。
- API は Web とネイティブの両方が使う。レスポンスの形（ADR 0009）や同期のメッセージ（ADR 0012）を変えるときは、ネイティブ側への影響も考える。

## Considered Options

- Mac と Windows を Tauri や Electron で1つのコードにする: Mac で一番長く使うのに、ネイティブの音声入力やメニューバー常駐が得にくい。Windows は検証できないので、作る理由がまだない。需要が見えたら、今の SPA を Tauri で包むことから検討する（Electron より軽く、Mac の Swift 版とぶつからない）
- iPhone と Android を React Native や Flutter で1つのコードにし、Watch だけ Swift にする: Watch のためにドメインを Swift に移すのは避けられず、Swift・TS・RN 側の3か所に判断が散る。Android は PWA で足りるうちは作らない
- 判断をなるべくサーバーに寄せ、ネイティブは表示だけにして二重実装を避ける: Watch がオフラインで動けず（ADR 0003）、ローカル通知も予約できないため不採用
