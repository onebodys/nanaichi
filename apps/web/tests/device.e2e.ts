import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { advanceClock, installPageClock } from "./page-clock.ts";

/** 開始のボタン。終了したあとは「次のセッションを開始」になる */
const START_BUTTON = /^(次のセッションを)?開始$/;

/**
 * ログインしないで使う（Issue #85、ADR 0019）。記録先はこの端末で、記録はこのブラウザの IndexedDB に残る。
 * テストごとにブラウザの保存先は空から始まるので、前の実行の記録は混ざらない。
 * この端末の記録先には同期の WebSocket がないので、ページの時計は通信の落ち着きだけを待って進める。
 */
describe("ログインしないで使う", () => {
  test("ログインしていなくてもホームにタイマーが表示され、ヘッダーのログインして同期からログイン画面へ進める", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/");
    await expect(browser).toHaveURL("/");
    await expect(screen.getByRole("button", { name: START_BUTTON })).toBeVisible();
    await expect(screen.getByRole("button", { name: "アカウント" })).toHaveCount(0);

    await screen.getByRole("link", { name: "ログインして同期" }).tap();
    await expect(browser).toHaveURL("/login");
    await expect(screen.getByRole("button", { name: "Google でログイン" })).toBeVisible();
  });

  test("設定画面のアカウントの欄に、記録がこのブラウザにあることとログインして同期が出る", async ({
    app,
    screen,
  }) => {
    await app.open("/");
    await screen.getByRole("button", { name: "設定" }).tap();
    await expect(screen.getByText("ログインしていません")).toBeVisible();
    await expect(screen.getByText(/記録はこのブラウザに保存されています/)).toBeVisible();
    await expect(screen.getByRole("heading", { name: "設定", level: 1 })).toBeVisible();
    await expect(screen.getByRole("link", { name: "ログインして同期" }).last()).toBeVisible();
  });

  test("タグをつけて記入を書き、読み込み直しても、タイムラインとスタッツの今日に残っている", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.addInitScript(installPageClock);
    await app.open("/");
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();

    // 集中を最後まで終えると完了セットになり、ジャーナルのフェーズに入る
    await advanceClock(browser, 7, { socket: false });
    await expect(screen.getByRole("heading", { name: "ジャーナル" })).toBeVisible();

    const input = screen.getByLabel("ジャーナル記入の本文");
    const tagInput = screen.getByRole("combobox", { name: "タグ" });
    await tagInput.tap();
    await tagInput.pressSequentially("#読書");
    await tagInput.press("Enter");
    await input.pressSequentially("この端末に残す記入");
    await input.press("Control+Enter");
    await expect(input).toHaveValue("");

    await browser.reload();

    const entry = screen.getByRole("listitem", { name: "ジャーナル記入" }).first();
    await expect(entry).toContainText("この端末に残す記入");
    await expect(entry.getByRole("list", { name: "タグ" })).toHaveText("#読書");
    await expect(screen.getByRole("heading", { name: /完了/, level: 3 }).first()).toHaveText(
      /完了 1セット · 集中 7分$/,
    );

    await screen.getByRole("button", { name: "スタッツ" }).tap();
    await screen.getByText("今日", { exact: true }).tap();
    await expect(screen.getByText("ジャーナル記入", { exact: true })).toBeVisible();
    await expect(screen.getByText("1セット · ", { exact: false }).first()).toBeVisible();
  });

  test("同じブラウザの別の画面で開始すると、読み込み直さなくても、もう一方の画面にセッションが出る", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/");
    await expect(screen.getByRole("button", { name: START_BUTTON })).toBeVisible();

    // 同じブラウザの別のタブの代わりに、同じ origin のもう1つの画面を埋め込む（保存先も BroadcastChannel も共有する）
    await browser.evaluate(`(() => {
      const frame = document.createElement("iframe");
      frame.title = "別の画面";
      frame.src = "/";
      frame.style.cssText = "position:fixed;right:0;bottom:0;width:480px;height:480px;z-index:9999";
      document.body.append(frame);
      return null;
    })()`);
    const other = browser.frameLocator('iframe[title="別の画面"]');
    await expect(other.getByRole("button", { name: START_BUTTON })).toBeVisible();

    await screen.getByRole("button", { name: START_BUTTON }).first().tap();
    await expect(screen.getByRole("heading", { name: "集中" }).first()).toBeVisible();
    await expect(other.getByRole("heading", { name: "集中" })).toBeVisible();
  });

  test("ページの時計が進んだあとに読み込み直して時計が戻っても、一時停止と再開ができる", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.addInitScript(installPageClock);
    await app.open("/");
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
    await advanceClock(browser, 3, { socket: false });

    // 読み込み直すとページの時計は進める前に戻るが、この端末の記録より前の時刻は記録しない
    await browser.reload();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
    await screen.getByRole("button", { name: "一時停止" }).tap();
    await expect(screen.getByRole("button", { name: "再開" })).toBeVisible();
    await screen.getByRole("button", { name: "再開" }).tap();
    await expect(screen.getByRole("button", { name: "一時停止" })).toBeVisible();
  });
});
