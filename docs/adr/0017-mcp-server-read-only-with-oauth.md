# MCP サーバーは記録を読むだけにし、OAuth で連携の許可を取る

ADR 0005 で、ジャーナルの振り返りや外部ツールとの連携は MCP サーバー経由にすると決めた。その MCP サーバーを、同じ Worker の `/api/mcp`（Streamable HTTP、ステートレス）に置く。Issue #36。

**できること**: 期間を指定したジャーナル記入（`get_journal_entries`）、スタッツ（`get_stats`）、タグ（`get_tags`）を読むことだけ。セッションの操作や記入の書き込みはしない。1週間の振り返りのまとめを AI に作らせる使い方を想定している。期間は `YYYY-MM-DD` の日付2つ（両端を含む）とタイムゾーン（IANA）で指定し、日付はそのタイムゾーンの 0:00 で区切る（スタッツと同じ考え方、ADR 0014）。1回に読めるのは 366 日まで。記入には、書いた日付と時刻（そのタイムゾーン）を添えて返す。判断と読み出しは HTTP の API と同じく UserDO のワークフローが行い、MCP のルートは形を変えるだけ。

**認証**: OAuth 2.1 で、MCP の認可の仕様に沿う。Better Auth の `@better-auth/mcp`（`@better-auth/oauth-provider` を MCP 向けに設定したもの）と `jwt()` プラグインを入れる。

- MCP クライアントは `/api/mcp` の 401 の `WWW-Authenticate` から、Protected Resource Metadata（RFC 9728、`/.well-known/oauth-protected-resource/api/mcp`）と認可サーバーのメタデータ（RFC 8414、`/.well-known/oauth-authorization-server/api/auth`）を見つける。仕様でオリジンの直下に置くことになっているので、`/.well-known/*` も Worker が受ける（`wrangler.jsonc` の `run_worker_first`）。
- MCP クライアントは事前に登録できないので、動的登録（RFC 7591）を誰にでも開く。Claude Code などは `http://localhost:<port>/callback` に戻させるため、`application_type` を送らないクライアントも loopback の http ならネイティブアプリとして登録する（`clientRegistrationDefaultApplicationType: "infer"`）。
- 登録しただけでは何も読めない。認可の途中でユーザーが nanaichi にログインし（Google、許可リストはこれまでどおり）、連携の許可の画面（`/oauth/consent`）で許可したクライアントだけがトークンを受け取る。誰でも登録できる以上、知らないうちに読まれないよう、許可の画面は省かない。画面には、クライアントが名乗った名前（自称）に加えて、実際に戻る先のホストを出す。
- アクセストークンは MCP サーバーの URL（`<origin>/api/mcp`）に宛てた JWT（1時間）。範囲（scope）は `journal:read`。リフレッシュトークンは 30 日。
- `/api/mcp` は、同じ Worker の Better Auth から公開鍵を直接読み、署名・発行者・宛先・期限・範囲を確かめる。Better Auth の `requireMcpAuth` は公開鍵を自分の `/api/auth/jwks` へ HTTP で取りに行くが、Workers は自分自身の URL への fetch が届かないことがあるため使わない。DPoP で縛ったトークンは、証明を確かめていないので断る。
- トークンが正しくても、そのユーザーが許可リストから外れていれば 403 にする（`requireSession` と同じ）。

## Consequences

- OAuth のテーブル（クライアント・トークン・同意・署名鍵など）が D1 に増える（`migrations/0002-mcp-oauth.sql`）。ユーザー横断の認証のデータなので D1 に置く（ADR 0002）。
- ジャーナル記入の本文（PII）が、ユーザーが許可した外部のツールに渡る。それがこの機能の目的なので、MCP の応答では本文を取り出して返す。
- Better Auth はリクエストごとに作っている（`auth.ts`）。`mcp()` プラグインは初期化のたびに MCP サーバーの resource の行を D1 で確かめるので、認証を使うリクエストは D1 を1回多く読む。遅さが見えたら、Better Auth のインスタンスを isolate の中で使い回すことを考える。
- MCP の仕様は MCP サーバーの URL を https か loopback に限っているので、portless の `http://*.localhost` では MCP サーバーを出さない（`base-url.ts` の `servesMcpOn`、`/api/mcp` は 404）。ローカルで試すときは `http://localhost:5173`（または `127.0.0.1:5173`）で開く。
- 許可した連携を画面から取り消す手段はまだない。リフレッシュトークンが切れる（30 日）まで、そのクライアントは読み続けられる。必要になったら設定画面に連携の一覧と取り消しを足す。
- 書き込み（記入を足すなど）が欲しくなったら、別の scope（例: `journal:write`）にして、連携の許可で選べるようにする。

## Considered Options

- API キー: ユーザーが画面でキーを発行し、MCP クライアントの設定に貼る。作るのは簡単だが、MCP クライアントの多く（Claude のコネクタなど）は OAuth を前提にしていて、キーを渡す手段がないか手作業になる。漏れたときに範囲や期限で縛りにくい。Better Auth で OAuth が組めたので不採用。
- 連携の許可の画面を出さない: 動的登録は誰にでも開いているので、悪意のあるクライアントの認可 URL を踏まされただけで、ログイン済みのユーザーの記録が読まれうる。不採用。
- Cloudflare の `agents`（`McpAgent`、Durable Object で MCP のセッションを持つ）: 読むだけのツールにはセッションが要らず、Durable Object と依存が増える。ステートレスな Streamable HTTP（`@modelcontextprotocol/server` の `createMcpHandler`）で足りる。
- Client ID Metadata Documents（`@better-auth/cimd`）: クライアントの身元を URL で確かめられるが、外部の URL を取りに行く仕組み（SSRF への備えを含む）が要る。今は動的登録と連携の許可で足りるので見送る。
