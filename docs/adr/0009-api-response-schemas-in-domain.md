# API の応答のスキーマは domain/ に置き、クライアントは通信層で検証してから使う

API の応答（成功の本文とエラーの本文）を検証する valibot のスキーマは、サーバーとブラウザの両方から使える `domain/` に、応答が表す型の隣に `<型名>JsonSchema` という名前で置く（例: `SessionSnapshotJsonSchema`、`TimerStateJsonSchema`、`ApiErrorBodyJsonSchema`）。スキーマは JSON にした値（時刻は ISO 8601 の文字列）を検証し、ドメインの型（時刻は `Date`）に戻す。出力の型は `v.GenericSchema<unknown, ドメインの型>` で注釈し、ドメインの型とずれたら型チェックで落ちるようにする。

サーバーはドメインの型をそのまま `c.json` で返し、エラーの本文は `satisfies ApiErrorBody` で種類を型で縛る。ブラウザの画面は fetch を直接呼ばず、`client/api.ts` の通信層（fetch → 本文の読み取り → スキーマで検証 → byethrow の Result）を通す。失敗は `NetworkError` / `ApiRejected`（エラーの種類つき）/ `UnexpectedResponse` の3種類で、画面は `kind` で扱いを決める。

## Consequences

- サーバーの実際の応答がスキーマに合うことは、Workers ランタイムの結合テスト（`session-api.workers.test.ts`）で確かめる。スキーマとドメインの型が往復できることは `session-snapshot-json.test.ts` で確かめる。
- エンドポイントを足したら、応答のスキーマを `domain/` に足し、通信層に関数を足し、同じ2種類のテストを書く。
- 検証の失敗（`ValidationError`）は通信層の外に出さない。指摘には応答の値が入りうる（今後はジャーナル記入の本文も入る）ため。
- ブラウザにはスキーマのぶんの valibot が配信される。valibot は tree-shaking で使う関数だけが入るので許容する。

## Considered Options

- Hono RPC（`hc`）で型だけを共有する: 型は共有できるが実行時の検証がなく、`Date` が文字列になることも型に現れないため不採用
- スキーマを `client/` に置く: サーバー側のテストで実際の応答を同じスキーマで確かめられないため不採用
