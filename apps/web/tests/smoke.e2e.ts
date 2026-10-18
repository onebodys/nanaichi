import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("ログイン画面が表示される", async ({ app, screen }) => {
  await app.open("/login");
  await expect(screen.getByRole("heading", { name: "nanaichi" })).toBeVisible();
  await expect(
    screen.getByRole("button", {
      name: "Google でログイン（CI の失敗を確かめるための一時的な変更）",
    }),
  ).toBeVisible();
});

test("未ログインでホームを開くとログイン画面に移る", async ({ app, browser, screen }) => {
  await app.open("/");
  await expect(browser).toHaveURL("/login");
  await expect(
    screen.getByRole("button", {
      name: "Google でログイン（CI の失敗を確かめるための一時的な変更）",
    }),
  ).toBeVisible();
});
