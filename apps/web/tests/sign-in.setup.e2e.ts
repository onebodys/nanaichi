import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * ログイン済みの状態を `signedIn` という名前で保存する。ログインが要る画面のテストは
 * `{ session: "signedIn" }` を付ければ、ログイン済みの状態から始まる（docs/E2E.md）。
 *
 * Google は通さず、テスト用のログイン（/api/test/sign-in、ADR 0008）を開く。
 * メールアドレスは e2e.config.ts の `ALLOWED_EMAILS` に載せたもの。
 */
test.setup(
  "ログイン済みの状態を用意する",
  { sessions: ["signedIn"] },
  async ({ app, browser, session }) => {
    await app.open("/api/test/sign-in?email=e2e%40example.com");
    // ホームへ戻されればログインできている
    await expect(browser).toHaveURL("/");
    await session.save("signedIn");
  },
);

/**
 * ログアウトを確かめるテスト専用のログイン済みの状態。ログアウトするとサーバー側のセッションが消えるので、
 * `signedIn` を使い回すと、後に走るテストがログイン画面に飛ばされてしまう。
 */
test.setup(
  "ログアウトするテスト用のログイン済みの状態を用意する",
  { sessions: ["signedInToSignOut"] },
  async ({ app, browser, session }) => {
    await app.open("/api/test/sign-in?email=e2e%40example.com");
    await expect(browser).toHaveURL("/");
    await session.save("signedInToSignOut");
  },
);
