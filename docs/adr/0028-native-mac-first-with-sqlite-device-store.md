# ネイティブは Mac から作り、この端末の記録は SQLite に、アカウントには Bearer トークンでつなぐ

ADR 0015 で、Apple の端末は Swift・SwiftUI で作ると決めた。そのとき最初に作るとしたのは iPhone + Apple Watch だったが、Mac から作る（Issue #122）。ネイティブアプリも Web と同じく、ログインしていなければこの端末の記録先で、ログインしていればアカウントの記録先で動く（ADR 0019）。機能は Web にあるものをすべて入れる。画面の基本の構成は Web と同じにし、細部はそれぞれのプラットフォームのデザインガイドライン（Human Interface Guidelines）に合わせる。

## Mac から作る

- オーナーがいちばん長くタイマーを使うのは Mac なので、ドッグフーディングでいちばん早く確かめられる。
- Mac のアプリは、Apple Developer Program に登録しなくても、ローカルで署名して自分の Mac で動かせる。iPhone の実機や Watch は、無料の署名だと7日ごとに入れ直しになる。Watch の拡張ランタイムセッションなども、配布の準備が要る。
- 作る順番は、Swift のドメイン（ゴールデンケースで TS と一致させる）→ Mac → iPhone + Watch → Watch 単体での動作、にする。
- 対応するのは macOS 26 以降にする。新しいデザイン（Liquid Glass）と、最近の SwiftUI の API をそのまま使うため。
- 当面は自分用のビルドだけで、配布（署名・公証・App Store）はしない。配布の方法は iPhone を作るときに決める。

## この端末の記録先は SQLite（GRDB）に置く

ログインしていない人の記録は、アプリのコンテナにある SQLite のファイルに置く。読み書きには GRDB を使う。

- スキーマは UserDO の SQLite と同じ形にする。同じ場面の一覧（Web の `testing/store-contract.ts`）を、Swift の記録先にも通して確かめる（ADR 0019 の Consequences と同じやり方）。
- 1つのワークフローの書き込みは、1つのトランザクションにする。タグの削除で記入を何件書き換えても、全部書くか何も書かないかのどちらかになる（UserDO の `transactionSync` と同じ）。
- ADR 0019 の「この端末の記録」にある約束は、IndexedDB に固有のもの（`navigator.locks`、`BroadcastChannel`、`navigator.storage.persist()`）を除いてそのまま守る。ID はすべて端末で発行する。元の時刻と削除の印を残す。時刻は記録済みのいちばん新しい時刻より前に戻さない。自動終了は読み込むたびに判断する。読み込めない記録は上書きしない。
- 1つのアプリの中で書くのは1つのプロセスなので、タブの間のロックは要らない。メニューバーとウィンドウなど、同じアプリの中の画面は、同じ記録先のオブジェクトから同期メッセージを受け取る。
- 記入の本文は、ブラウザと同じく端末の中に平文で残る。Sensitive に相当する型で包み、ログやエラーの文字列には出さない。

## ログインは Google だけにし、Bearer トークンでアカウントにつなぐ

- ログインは `ASWebAuthenticationSession` で Google の画面を開き、カスタム URL スキームでアプリに戻る。アプリは Cookie の代わりにトークンを受け取り、Keychain に置く。
- `/api/*` と `GET /api/ws`（WebSocket）は、Cookie に加えて `Authorization: Bearer` でも認証できるようにする。許可リストとレート制限は Web と同じに効かせる。トークンの発行と失効のしかたは、サーバーを変えるとき（Issue #144）に決める。
- Sign in with Apple は、App Store に出すとき（iPhone の段階）に足す。App Store の規約では、Google のログインを置くなら Sign in with Apple も置く必要がある。自分用のビルドのうちは要らない。

## Mac は XCUITest で確かめ、iPhone から e2e を使う

- Web の E2E に使っている e2e（tester-army/e2e）は、Web と iOS / Android のシミュレーター・実機には対応しているが、macOS のネイティブアプリには対応していない。Mac の画面の確かめとスクリーンショットは XCUITest で行い、CI の macOS のランナーで走らせる。
- アプリは最初から SwiftUI の multiplatform ターゲットにする。iPhone / iPad を作るときには、iOS のシミュレーターの上で e2e（`@e2e-dev/mobile`）をそのまま使う。
- ドメインとワークフローは Swift Package にして、`swift test` で確かめる。テスト名は Web と同じく日本語で、GLOSSARY の用語を使った場面として書く。

## 置き場所

モノレポの `apps/apple/` に置く。ゴールデンケースの JSON は TS と Swift の両方から読めるようにする。依存の向きは Web と同じで、ドメインは I/O もフレームワークも import しない。ワークフローはドメインだけを使う。画面と記録先は外側に置く（AGENTS.md の3章）。

## Consequences

- ADR 0015 の「最初に作るのは iPhone + Apple Watch」と作る順番は、この ADR で置き換える。
- ADR 0019 のこの端末の記録先は、Web では IndexedDB に、ネイティブでは SQLite に置く。Web とネイティブのこの端末の記録は別のもので、互いに同期しない。どちらもログインして取り込めばアカウントにまとまる（ADR 0020）。
- サーバーは Cookie と Bearer トークンの2つの認証を受けるようになる。Web の Cookie の流れは変えない。
- Mac の画面は e2e のテストの一覧に入らず、XCUITest の一覧になる。E2E が2つの仕組みに分かれる。
- CI に macOS のランナーが増える。Linux のランナーより遅く高いので、`apps/apple/` が変わったときだけ走らせる。

## Considered Options

- ADR 0015 のとおり iPhone + Watch から作る: 実機での確かめに配布の準備が要り、最初の一歩が重い。Watch の価値（振動）は、Mac で記録先と同期が固まってからでも足せる。
- この端末の記録を SwiftData（Core Data）に置く: スキーマが自動で決まり、UserDO の SQLite と同じ形にしにくい。そうなると、同じ場面の一覧を通して比べにくい。複数の書き込みを1つのトランザクションにすることも、GRDB ほど明示的には書けない。
- この端末の記録を JSON のファイル1つに置く: 書き込みのたびに丸ごと書き換えることになり、記録が増えると遅くなる。ADR 0019 で IndexedDB の1文書を採らなかったのと同じ理由。
- Mac の画面も e2e で確かめるため、Mac Catalyst（iPad の画面を Mac で動かす）にする: e2e の対応先に Mac Catalyst はない。Mac の流儀（メニューバー、ウィンドウ、メニュー）にも合わせにくい。
