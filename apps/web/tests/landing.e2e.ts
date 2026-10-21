import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// LP（Issue #90、ADR 0018）。ログインしていない人に `/` で見せる

test("未ログインで / を開くと、URL はそのままで LP が出て、ログインへの導線はない", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  await expect(browser).toHaveURL("/");
  await expect(screen.getByRole("heading", { name: /^7分集中して、\s*1分書く$/ })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Google でログイン" })).not.toBeVisible();
  await expect(screen.getByRole("link", { name: "ログイン" })).not.toBeVisible();
});

test("LP でタイマーを始めると集中が始まり、書いた記入がそのセットの集中としてタイムラインに出る", async ({
  app,
  screen,
}) => {
  await app.open("/");
  await screen.getByRole("button", { name: "1セットやってみる" }).click();
  await expect(screen.getByRole("button", { name: "一時停止" })).toBeVisible();

  await screen.getByLabel("ジャーナル記入の本文").fill("見積もりの前提を書き出した");
  await screen.getByRole("button", { name: "送信" }).click();
  await expect(screen.getByText("見積もりの前提を書き出した")).toBeVisible();
  await expect(screen.getByText("1-1 集中")).toBeVisible();
});

test("LP で集中 → ジャーナルを手動にして60倍速で始めると、7分のところで切り替え待ちになる", async ({
  app,
  screen,
}) => {
  await app.open("/");
  await screen.getByRole("switch", { name: "集中 → ジャーナルを自動で進める" }).click();
  await screen.getByRole("button", { name: "60倍速で1ラウンドを見る" }).click();
  await expect(screen.getByRole("button", { name: "ジャーナルを始める" })).toBeVisible({
    timeout: 15_000,
  });
});

test(
  "ログインしていれば / はタイマーの画面のまま",
  { session: "signedIn" },
  async ({ app, screen }) => {
    await app.open("/");
    await expect(screen.getByRole("button", { name: "アカウント" })).toBeVisible();
  },
);
