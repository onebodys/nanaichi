# Web の API の応答の例

`api-responses.json` は、Web の Worker（`apps/web`）に実際にリクエストして受け取った応答と同期メッセージ。Swift のドメインが Web の API の応答をそのまま読めることを、`ApiResponseTests.swift` で確かめる（Issue #140）。

## 作り方

Workers のテストの土台（`apps/web/src/server/workers-test-harness.ts`）でログインし、セッションの開始・操作、ジャーナル記入、タグの削除、進め方と ToDo の設定、タスクの作成・完了・削除を順に行って、各エンドポイントの応答（`status` と `body`）と、WebSocket（`GET /api/ws`）に届いた同期メッセージを書き出した。時刻は `vi.setSystemTime` で 2100-01-01 から進めている。

API の形が変わったら、同じ流れのテストを `apps/web/src/server/` に一時的に置き、`expect(JSON.stringify(captured, null, 2)).toMatchFileSnapshot(...)` でこのファイルに書き出し直す（`vp test --config vitest.workers.config.ts -u <ファイル>`）。書き出したテストはコミットしない。

# 取り込みの束の例

`import-batch.json` は、Mac アプリがこの Mac の記録をアカウントへ取り込むとき（ADR 0020）に `POST /api/imports` へ送る束の例。向きは `api-responses.json` と逆で、Swift が送る側になる。

- Swift の `ImportTests.swift`（NanaichiDomainTests）が、ドメインの値を JSON にするとこのファイルと同じ形になることを確かめる
- TS の `apps/web/src/domain/import.test.ts` が、サーバーの検証（`ImportBatchJsonSchema`）がこのファイルを受け付けることを確かめる

束の形を変えたら、両方のテストが通るようにこのファイルを直す。
