# ユーザー横断のデータは D1、ユーザーごとのデータは各ユーザー専用の Durable Object に置く

Better Auth のテーブルと将来の課金情報（Web は Stripe、iOS は IAP の二系統になる見込みなので、支払い経路に依存しない「利用権」をユーザーに持たせる）はユーザーをまたいで参照するため D1 に置く。タイマー状態・セッション・ジャーナル記入はユーザーごとの DO（SQLite storage）に置き、DO の WebSocket（Hibernation API）で複数タブ・複数デバイスへリアルタイムに同期する。

## Consequences

ユーザー横断の集計は DO からはできない。必要になったら別途パイプラインを用意する。
