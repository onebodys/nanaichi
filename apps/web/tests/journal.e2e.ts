/// <reference lib="dom" />
// 時計の差し替えはページの中で動くので、ブラウザの型（DOM）を使う
import { describe, test, type Browser } from "@e2e-dev/web";
import { expect, type App } from "e2e";

/**
 * ジャーナル記入とタイムライン（Issue #6）。
 *
 * ジャーナルのフェーズに入るのを7分待たずに確かめるため、tests/timer.e2e.ts と同じく
 * ページの時計（`Date.now`）を進められるようにする（docs/E2E.md「時間の経過・音・通知のテスト」）。
 */
const installClock = () => {
  if ("__advanceClock" in window) {
    return;
  }
  const realNow = Date.now.bind(Date);
  let shift = 0;
  Date.now = () => realNow() + shift;
  Object.assign(window, {
    __advanceClock: (ms: number) => {
      shift += ms;
    },
  });
};

const advanceClock = (browser: Browser, minutes: number) =>
  browser.evaluate<null>(`(window.__advanceClock(${minutes * 60_000}), null)`);

/** 前の実行のセッションが残っていれば終了しておき（docs/E2E.md）、セッションなしの画面を開く */
const openWithoutSession = async (app: App, browser: Browser) => {
  const baseUrl = app.baseUrl ?? "http://localhost:5173";
  const cookie = (await browser.cookies()).map(({ name, value }) => `${name}=${value}`).join("; ");
  await fetch(new URL("/api/session/commands", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id: crypto.randomUUID(), kind: "End" }),
  });
  await browser.addInitScript(installClock);
  await app.open("/");
};

// どのテストも同じユーザーのセッションを使うので、並べて走らせない
describe("ジャーナル記入とタイムライン", { serial: true, session: "journalWriter" }, () => {
  test("セッションの外では入力欄を使えず、開始すると書けるようになる", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    const input = screen.getByLabel("ジャーナル記入の本文");

    await expect(input).toBeDisabled();

    await screen.getByRole("button", { name: "開始" }).tap();
    await expect(input).toBeEnabled();

    await screen.getByRole("button", { name: "終了" }).tap();
    await expect(input).toBeDisabled();
  });

  test("Enter で送信し、Shift+Enter で改行する。送信すると空になり、続けて書けて、新しい記入が上に並ぶ", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: "開始" }).tap();
    const input = screen.getByLabel("ジャーナル記入の本文");
    await expect(input).toBeEnabled();

    await input.pressSequentially("設計を書いた");
    await input.press("Shift+Enter");
    await input.pressSequentially("参考 https://example.com/e2e");
    await expect(input).toHaveValue("設計を書いた\n参考 https://example.com/e2e");
    await input.press("Enter");
    await expect(input).toHaveValue("");

    await input.pressSequentially("続けて2件目");
    await input.press("Enter");
    await expect(input).toHaveValue("");

    const entries = screen.getByRole("listitem", { name: "ジャーナル記入" });
    await expect(entries).toHaveCount(2);
    await expect(entries.first()).toContainText("続けて2件目");
    await expect(entries.nth(1)).toContainText("設計を書いた");
    await expect(entries.first()).toContainText("1ラウンド目・1セット目・集中");
    // URL だけがリンクになる
    await expect(screen.getByRole("link", { name: "https://example.com/e2e" })).toHaveAttribute(
      "href",
      "https://example.com/e2e",
    );

    await screen.getByRole("button", { name: "終了" }).tap();
  });

  test("ジャーナルのフェーズに入ると入力欄にカーソルが置かれ、日付の区切りに完了セット数が出る", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: "開始" }).tap();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
    // 集中中は入力欄からカーソルを外しておく
    await screen.getByRole("button", { name: "一時停止" }).focus();

    await advanceClock(browser, 7);

    await expect(screen.getByRole("heading", { name: "ジャーナル" })).toBeVisible();
    await expect(screen.getByLabel("ジャーナル記入の本文")).toBeFocused();
    await expect(screen.getByRole("heading", { name: /完了セット 1$/ })).toBeVisible();

    await screen.getByRole("button", { name: "終了" }).tap();
  });

  test("記入を編集・削除できる", async ({ app, browser, screen }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: "開始" }).tap();
    const input = screen.getByLabel("ジャーナル記入の本文");
    await input.pressSequentially("書き間違い");
    await input.press("Enter");
    const entry = screen.getByRole("listitem", { name: "ジャーナル記入" }).first();
    await expect(entry).toContainText("書き間違い");

    await entry.getByRole("button", { name: "編集" }).tap();
    const editor = screen.getByLabel("記入を編集");
    await editor.fill("書き直した");
    await editor.press("Enter");
    await expect(entry).toContainText("書き直した");
    await expect(entry).toContainText("編集済み");

    // セッションを終えたあとでも削除できる
    await screen.getByRole("button", { name: "終了" }).tap();
    await entry.getByRole("button", { name: "削除" }).tap();
    await screen.getByRole("button", { name: "削除する" }).tap();
    await expect(screen.getByText("書き直した")).toHaveCount(0);
  });
});
