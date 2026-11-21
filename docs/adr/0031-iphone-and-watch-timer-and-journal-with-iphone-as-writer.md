# iPhone と Watch はタイマーとジャーナルに絞り、記録を書くのは iPhone だけにする

ADR 0015 で Apple の端末は Swift・SwiftUI で作ると決め、ADR 0028 で Mac から作ることにした。その次に作る iPhone と Apple Watch の作り方をここで決める（Issue #69）。ログインと、この端末の記録先は Mac と同じにする（ADR 0028・0029）。

## 範囲はタイマーとジャーナル

- iPhone と Watch で作るのは、タイマーとジャーナル記入だけにする。持ち歩く端末でほしいのは、セッションを回すことと、ジャーナルの1分で一言を残すこと。スタッツ・タスク・タグの管理・設定の画面は、Web と Mac で使う。
- Watch でできるのは、開始・中断・音声入力でのジャーナル記入の3つにする。Watch の画面にはフェーズと残り時間を出し、フェーズの切り替わりを振動で知らせる。
- 対応するのは iOS 26・watchOS 26 以降にする。iPhone で文字にするのに使う SpeechAnalyzer が iOS 26 からで、Mac（macOS 26 以降、ADR 0028）とも揃う。

## Watch は WatchConnectivity で iPhone につなぎ、記録を書くのは iPhone だけ

- Watch と iPhone は WatchConnectivity でつなぐ。Watch は操作（開始・中断）と録音した音声を iPhone に送り、iPhone はスナップショットを Watch に送る。Watch は受け取ったスナップショットから、ドメインの関数でタイマーの状態を計算して表示する（ADR 0003）。
- 記録を書くのは iPhone だけにする。Watch は記録先を持たず、iPhone から届いた操作をワークフローに通すのも iPhone の記録先（ログインしていなければ SQLite、していればアカウント）である。記録を書く場所が1つなら、Watch と iPhone の記録のマージを考えなくてよい。
- 初版の Watch は iPhone を経由して動けばよい。iPhone に届かないあいだの Watch は操作を受け付けず、届かないことを画面に出す。Watch が単体で、iPhone もネットもない状態で動くこと（オフラインでの記録のマージ）は、そのあとに作る（ADR 0015）。

## 音声入力は Watch で録音し、iPhone の SpeechAnalyzer で文字にする

1. Watch で録音する。
2. 録音したファイルを WatchConnectivity で iPhone に送る。
3. iPhone の SpeechAnalyzer で、端末の中で文字にする。
4. 文字にした本文を、ジャーナル記入として iPhone の記録先に書く。
5. 文字にしたら、音声のファイルを iPhone と Watch の両方から消す。Watch のファイルは、iPhone に届いたことを確かめてから消す。

本文と音声は端末の外に出さない（PRODUCT.md の音声入力の方針、#33）。外に出るのは、文字にしたジャーナル記入を、ログインしているときにアカウントの記録先に書くときだけで、これは画面から記入したときと同じ。音声のファイルはどこにも残さない。本文は Sensitive に相当する型で包み、ログやエラーの文字列には出さない（ADR 0028）。

## Watch の OS の音声入力は使わない

watchOS の標準の音声入力（テキスト入力の画面の音声入力）は、端末の中で文字にするか、Apple のサーバーに送って文字にするかを、アプリから指定できない。PII であるジャーナルの本文が端末の外に出ないことを保証できないので使わない。iPhone の SpeechAnalyzer は端末の中で文字にするので、こちらを使う。

## Apple Developer Program への登録と配布

- Apple Developer Program には、実機の Watch で振動を確かめるときに登録する。それまでは iPhone と Watch のシミュレーターで作る。無料の署名では Watch の実機に入れても7日ごとに入れ直しになり、拡張ランタイムセッションなども配布の準備が要る（ADR 0028）。
- 配布（TestFlight・App Store）の方法は、この ADR では決めず後回しにする。ADR 0028 は「配布の方法は iPhone を作るときに決める」としていたが、iPhone と Watch を自分で使えるようになってから決める。

## 確かめ方

- iPhone は、iOS のシミュレーターの上で e2e（`@e2e-dev/mobile`）と XCUITest で確かめる（ADR 0028）。
- Watch は、watchOS のシミュレーターの上で XCUITest で確かめる。e2e は watchOS に対応していない。
- 振動はシミュレーターでは確かめられないので、実機の Watch でオーナーが確かめる。
- ドメインとワークフローは、Mac と同じ Swift Package の `swift test` で確かめる。

## Consequences

- ADR 0028 の「機能は Web にあるものをすべて入れる」は、iPhone と Watch には当てはめない。Mac は Web にあるものをすべて入れ、iPhone と Watch はタイマーとジャーナルに絞る。
- Watch は記録先を持たないので、Watch 単体での動作を作るときは、Watch に記録先を置き、iPhone の記録とマージするしくみを別に決める。
- iPhone に届かないあいだは Watch で操作できない。手首だけで使い続けたい場面には、Watch 単体での動作ができるまで応えられない。
- 音声入力は iPhone がないと文字にできない。Watch 単体での動作を作るときに、Watch の中で文字にする方法を改めて考える。
- 振動の確かめはオーナーの手元の実機に頼り、CI では確かめない。
- Watch の画面は e2e のテストの一覧に入らず、XCUITest の一覧になる。

## Considered Options

- **Watch の OS の音声入力を使う**: 実装は小さく、iPhone がなくても文字にできる。しかし端末の中で文字にすることをアプリから指定できず、本文が外に出ないことを保証できない。
- **Watch も記録先を持ち、iPhone と両方で書く**: iPhone に届かなくても Watch で操作できる。しかし2つの記録先のマージ（同じセッションへの操作の重なり、時刻の前後）を初版から決めることになる。ADR 0015 のとおり、Watch 単体での動作はそのあとに作る。
- **Watch が直接サーバーにつなぐ**: iPhone がなくてもネットがあれば動く。しかしログインしていない人の記録は iPhone の端末の中にあるので、Watch から書けない。Watch にもトークンを置くことになり、ログインの流れも Watch 用に要る。
- **iPhone も Web にあるものをすべて入れる（ADR 0028 の Mac と同じ）**: スタッツやタスクの画面は、持ち歩く端末で使う場面が少なく、先にタイマーとジャーナルの体験を固めたい。
