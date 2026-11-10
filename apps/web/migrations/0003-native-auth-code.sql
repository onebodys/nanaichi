-- ネイティブアプリのログインで、トークンと引き換える使い捨てのコード（ADR 0029）。
--
-- `native-auth-routes.ts` が、Google のログインを終えたセッションに1つ発行し、アプリがコードと
-- code_verifier を送ってきたら `delete ... returning` で取り出す。取り出した時点で消えるので、2回は使えない。
-- コードを渡したセッションが消えれば（ログアウト）、まだ引き換えていないコードも一緒に消える。
-- 期限（`expiresAt`、UNIX ミリ秒）を過ぎた行は、次にコードを発行するときにまとめて消す。
--
-- 適用: `wrangler d1 migrations apply nanaichi --local` / `--remote`

create table "nativeAuthCode" ("code" text not null primary key, "codeChallenge" text not null, "sessionId" text not null references "session" ("id") on delete cascade, "expiresAt" integer not null);
