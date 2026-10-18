import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("ログイン画面が表示される", async ({ app, screen }) => {
  await app.open("/login");
  await expect(screen.getByRole("heading", { name: "nanaichi" })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Google でログイン" })).toBeVisible();
});

test("未ログインでホームを開くとログイン画面に移る", async ({ app, browser, screen }) => {
  await app.open("/");
  await expect(browser).toHaveURL("/login");
  await expect(screen.getByRole("button", { name: "Google でログイン" })).toBeVisible();
});

test("開発サーバーではログイン画面の開発用ログインからログインできる", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/login");
  await screen.getByLabel("開発用ログインのメールアドレス").fill("e2e@example.com");
  await screen.getByRole("button", { name: "開発用ログイン" }).click();
  await expect(browser).toHaveURL("/");
  await expect(screen.getByRole("button", { name: "ログアウト" })).toBeVisible();
});
