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
