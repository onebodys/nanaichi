# ネイティブアプリには、PKCE の形の使い捨てのコードと引き換えにセッションのトークンを渡し、Bearer で受ける

ADR 0028 で、ネイティブアプリ（まず Mac）は `ASWebAuthenticationSession` で Google にログインし、カスタム URL スキームでアプリに戻り、cookie の代わりに `Authorization: Bearer` でアカウントにつなぐと決めた。トークンの発行と失効のしかたはここで決める（Issue #144）。ログインは Google だけのまま変えない。

## ログインの流れ

PKCE（RFC 7636）と同じ形にする。アプリは code_verifier（43〜128 文字）を作って手元に残し、その SHA-256 を base64url にした code_challenge だけを送る。

1. アプリが `ASWebAuthenticationSession` で `GET /api/native-auth/start?code_challenge=<S256>&code_challenge_method=S256` を開く。サーバーは challenge と始めた時刻を署名つきの cookie（`nanaichi_native_sign_in`、10 分、HttpOnly、`Path=/api/native-auth`）に入れ、Better Auth の Google のログインへリダイレクトする。`plain` は受けない（400）。
2. Google のログインを終えると、Better Auth はいつもどおりセッションを作り、`GET /api/native-auth/callback` に戻す。サーバーは次をすべて満たすときだけ、使い捨てのコードを発行して `nanaichi://auth/callback?code=<コード>` にリダイレクトする。満たさなければ `nanaichi://auth/callback?error=EMAIL_NOT_ALLOWED`（許可リスト）か `?error=SIGN_IN_FAILED`（それ以外）にする。
   - 同じブラウザで `start` を開いている（cookie がある）
   - セッションがあり、ユーザーが許可リストに載っている
   - セッションが `start` を開いたあとに作られている（この流れの Google のログインで作ったもの）
3. アプリが `POST /api/native-auth/token` に `{ "code": "...", "code_verifier": "..." }` を JSON で送る。コードが期限内で、code_verifier から求めた challenge が発行したときのものと同じなら `200 { "token": "..." }` を返す。そうでなければ `400 { "error": "INVALID_GRANT" }`。知らない・使用済み・期限切れ・code_verifier の違いは区別して返さない。
4. アプリはトークンを Keychain に置き、`/api/*` と `GET /api/ws` に `Authorization: Bearer <token>` を付ける。ログアウトは `POST /api/auth/sign-out` に同じヘッダを付ける。

コードは 32 バイトの乱数で、期限は 60 秒。発行したセッションと challenge に結びつけて D1 の `nativeAuthCode` に置く（`migrations/0003-native-auth-code.sql`）。引き換えは `delete ... returning` で取り出すので、code_verifier が違っても、取り出した時点でそのコードは使えなくなる。

Google に登録するリダイレクト URI は変わらない。Google から戻る先は今までどおり Better Auth の `/api/auth/callback/google` で、アプリのスキームへは nanaichi のサーバーから戻す。

## トークンは Better Auth のセッションのトークン

アプリが受け取るのは、Better Auth のセッションのトークンに cookie と同じ署名を付けたもの。Better Auth の `bearer` プラグインが、`Authorization: Bearer` をセッションの cookie に読み替える。

- 期限と延長は画面のセッションと同じ（7 日、使えば延びる）。期限を過ぎれば 401 になり、アプリはログインし直す。
- ログアウトするとセッションの行が消え、そのトークンは 401 になる。まだ引き換えていないコードも、セッションと一緒に消える（外部キーの `on delete cascade`）。
- アプリのセッションは、ログインの流れで作った別のセッションなので、アプリでログアウトしても画面のセッションは残る。
- `bearer` プラグインは署名つきのトークンだけを受ける（`requireSignature`）。D1 の `session.token` を読めただけではなりすませない。
- `bearer` プラグインの `after` のフックは外す。これは、セッションの cookie を設定する応答のすべてに `set-auth-token` のヘッダでトークンを載せる。画面の `get-session` の応答にも載るので、HttpOnly の cookie に入れたトークンをページの JavaScript が読めるようになってしまう（`auth.ts` の `acceptBearerToken`）。

## Bearer でも Web と同じに守る

- `requireSession` は、`Authorization: Bearer` があればそれだけで、なければ cookie でセッションを確かめる。そのあとは同じで、許可リスト（403）とレート制限（ADR 0018、ユーザーごとに画面・ネイティブ・MCP の合計）がそのまま効く。
- 同期の WebSocket（ADR 0012）の Origin の確かめは、cookie で通ったときだけにする。Origin を確かめるのは、別のサイトのページが cookie を使って繋ぐのを防ぐため。ブラウザの WebSocket は `Authorization` を付けられないので、Bearer で通ったリクエストはそのページからではない。ネイティブアプリは Origin を送らない。

## 守りたいこと

- **カスタム URL スキームにトークンを載せない。** スキームは別のアプリも登録でき、どのアプリに届くかは保証されない。届くのはコードだけで、code_verifier はアプリから出ないので、横取りしたアプリは引き換えられない。
- **ログイン済みのブラウザで `start` のリンクを踏ませただけではトークンを渡さない。** スキームを横取りするアプリが自分の challenge で `start` を開かせたとき、ブラウザに前からある画面のセッションでコードを発行すると、操作なしでそのアプリにトークンが渡る。`start` のあとに作られたセッションに限れば、Google の画面でアカウントを選ぶ操作を必ず挟む（`prompt: "select_account"`）。この操作は止めない。OAuth のネイティブアプリ（RFC 8252）が認可の画面に頼るのと同じ。
- **アプリは `prefersEphemeralWebBrowserSession` を `true` にする。** ログインの流れで作ったセッションの cookie を Safari と分け、Safari に残さないため。

## Consequences

- D1 に `nativeAuthCode` のテーブルが増える。引き換えられずに残った行は、次にコードを発行するときに期限切れの分を消す。ログインのたびに数行の書き込みが増えるだけで済む。
- 流れの全体は、Google の画面のところだけをテスト用のログインに差し替えて、結合テストで歩ける（`native-auth-test-flow.ts`）。Node（`native-auth.test.ts`）でコードと引き換えとトークンの失効を、Workers（`native-auth-api.workers.test.ts`）で WebSocket とレート制限を確かめる。本物の Google のログインと `ASWebAuthenticationSession` は、本番で Mac のアプリから確かめる。
- トークンを `set-auth-token` で受け取る `bearer` の使い方（Better Auth の文書の例）はできない。トークンが欲しいクライアントは、この流れを通る。
- トークンの署名は better-call の cookie の署名と同じ形で、`native-auth-routes.ts` が自分で付けている。better-auth を上げて形が変われば、引き換えたトークンで API を呼ぶテストが落ちる。
- Sign in with Apple を足すとき（ADR 0028）も、`start` で選ぶプロバイダを増やすだけで、コードと引き換えの流れはそのまま使える。

## Considered Options

- **既にある OAuth のサーバー（`@better-auth/oauth-provider`、ADR 0023）にアプリをクライアントとして登録する**: 認可コードと PKCE が揃っていて、RFC 8252 のとおりになる。ただしアクセストークンは MCP サーバーに宛てた JWT（1 時間）で、`journal:read` の範囲に絞ってある。`/api/*` で JWT を確かめる経路と、書き込みの範囲と、リフレッシュトークンの更新をアプリに足すことになる。JWT はログアウトしてもすぐには失効しない。portless の `*.localhost` では OAuth のサーバーを出していない。アプリが欲しいのは画面と同じセッションなので不採用。
- **カスタム URL スキームに直接トークンを載せる**（`nanaichi://auth/callback?token=...`）: いちばん短いが、スキームを登録した別のアプリがトークンを受け取れる。不採用。
- **Universal Links（`https://nanaichi.app/...` でアプリを開く）でスキームの横取りを防ぐ**: Associated Domains に Apple Developer Program が要る。自分用のビルドのうちは使えない（ADR 0028）。配布するときに足せば、PKCE と重ねて守れる。
- **コードを UserDO に置く**: 引き換えのリクエストはコードしか持たず、どのユーザーの UserDO かがわからない。コードにユーザー ID を入れればたどれるが、ユーザー横断の認証のデータは D1 に置くという分け方（ADR 0002）から外れる。
- **コードを Workers KV に置く**: 結果整合なので、同じコードを2回引き換えるのを確実には止められない。D1 の `delete ... returning` なら1回だけ取り出せる。
- **コードを Better Auth の `verification` テーブルに置く**: マイグレーションは要らないが、Better Auth のアダプタでは読むと消すが別の操作になり、2回の引き換えが同時に来ると両方が通りうる。Better Auth のテーブルに SQL を直接書くのも避けたい。
