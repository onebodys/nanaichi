-- Better Auth のコアスキーマ（user / session / account / verification）。
--
-- 生成方法: Better Auth は Kysely アダプタで接続先の DB を introspection するため、
-- CLI（`npx auth generate`）は Worker の中にしか無い D1 を直接扱えない。
-- そこで同じ設定の Better Auth をメモリ上の SQLite（node:sqlite）に対して初期化し、
-- `getMigrations().runMigrations()` が作った DDL をそのまま書き出している。
-- better-auth を上げたときは同じ手順で作り直すこと（テーブル順のみ user を先頭に並べ替えている）。
--
-- 適用: `wrangler d1 migrations apply nanaichi --local` / `--remote`

CREATE TABLE "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" integer not null,
  "image" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE TABLE "session" (
  "id" text not null primary key,
  "expiresAt" date not null,
  "token" text not null unique,
  "createdAt" date not null,
  "updatedAt" date not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade
);

CREATE TABLE "account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  "scope" text,
  "password" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE TABLE "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" date not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE INDEX "account_userId_idx" on "account" ("userId");

CREATE INDEX "session_userId_idx" on "session" ("userId");

CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");
