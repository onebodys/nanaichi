import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test(
  "ログインするとホームが表示される",
  { session: "signedIn" },
  async ({ app, browser, screen }) => {
    await app.open("/");
    await expect(browser).toHaveURL("/");
    await expect(screen.getByRole("heading", { name: "nanaichi" })).toBeVisible();
    // ログイン中のアカウントとログアウトは、ヘッダーのアカウントのメニューにある
    await screen.getByRole("button", { name: "アカウント" }).tap();
    await expect(screen.getByText("Test User としてログインしています")).toBeVisible();
    await expect(screen.getByRole("menuitem", { name: "ログアウト" })).toBeVisible();
  },
);

test(
  "ログアウトするとログイン画面に移る",
  { session: "signedInToSignOut" },
  async ({ app, browser, screen }) => {
    await app.open("/");
    await screen.getByRole("button", { name: "アカウント" }).tap();
    await screen.getByRole("menuitem", { name: "ログアウト" }).tap();
    await expect(browser).toHaveURL("/login");
    await expect(screen.getByRole("button", { name: "Google でログイン" })).toBeVisible();
  },
);

test(
  "設定画面でテーマにダークを選ぶとすぐ暗くなり、開き直しても覚えている",
  { session: "signedIn" },
  async ({ app, browser, screen }) => {
    await app.open("/");
    await screen.getByRole("button", { name: "設定" }).tap();
    await screen.getByRole("radio", { name: "ダーク" }).tap();
    const isDark = () =>
      browser.evaluate(() => document.documentElement.classList.contains("dark"));
    expect(await isDark()).toBe(true);

    // 開いていた設定画面は URL に残るので、開き直しても設定画面のまま
    await browser.reload();
    await expect(screen.getByRole("heading", { name: "設定", level: 1 })).toBeVisible();
    expect(await isDark()).toBe(true);

    // 端末に合わせる（既定）に戻しておく
    await screen.getByRole("radio", { name: "ライト" }).tap();
    expect(await isDark()).toBe(false);
    await screen.getByRole("radio", { name: "端末に合わせる" }).tap();
    await screen.getByRole("button", { name: "タイマーに戻る" }).tap();
    await expect(screen.getByRole("heading", { name: "設定", level: 1 })).toHaveCount(0);
  },
);
