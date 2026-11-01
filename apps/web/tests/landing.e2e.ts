import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// LP（Issue #90、ADR 0018）。ベータ版のあいだは `/lp` で見せ、`/` はアプリのまま

test("未ログインで /lp を開くと、ベータ版の LP が出て、ログインへの導線はない", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/lp");
  await expect(browser).toHaveURL("/lp");
  await expect(screen.getByRole("heading", { name: /^集中は、\s*リズムで続く$/ })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Google でログイン" })).not.toBeVisible();
  await expect(screen.getByRole("link", { name: "ログイン" })).not.toBeVisible();
  await expect(screen.getByRole("link", { name: "ベータ版" })).toBeVisible();
  await expect(screen.getByRole("heading", { name: "いまできること、これから" })).toBeAttached();
});

test("LP でタイマーを始めると集中が始まり、書いた記入がそのセットの集中としてタイムラインに出る", async ({
  app,
  screen,
}) => {
  await app.open("/lp");
  await screen.getByRole("button", { name: "1セットやってみる" }).click();
  await expect(screen.getByRole("button", { name: "一時停止" })).toBeVisible();

  await screen.getByLabel("ジャーナル記入の本文").fill("見積もりの前提を書き出した");
  await screen.getByRole("button", { name: "送信" }).click();
  await expect(screen.getByText("見積もりの前提を書き出した")).toBeVisible();
  await expect(screen.getByText("1-1 集中")).toBeVisible();
});

test(
  "ログインしていても / はタイマーの画面のまま（LP は /lp にだけ出る）",
  { session: "signedIn" },
  async ({ app, screen }) => {
    await app.open("/");
    await expect(screen.getByRole("button", { name: "アカウント" })).toBeVisible();
  },
);
