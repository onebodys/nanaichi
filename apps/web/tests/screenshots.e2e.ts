/// <reference lib="dom" />
// 内容の高さはページの中で測るので、ブラウザの型（DOM）を使う
import { copyFile, mkdir } from "node:fs/promises";
import { describe, test, type Browser } from "@e2e-dev/web";
import { expect, type App, type Screen } from "e2e";
import { advanceClock, installPageClock } from "./page-clock.ts";

/** 撮った画面の置き場所。scripts/screenshot-gallery.ts がここから一覧の HTML を作る */
const SCREENSHOT_DIR = ".e2e/screenshots";

const START_BUTTON = /^(次のセッションを)?開始$/;

const VIEWPORTS = [
  { label: "PC", width: 1280, height: 800 },
  { label: "スマホ375px", width: 375, height: 812 },
] as const;

/**
 * ページの全体が写るように画面の高さを内容に合わせて撮り、リトライしても同じ名前になる場所へコピーする。
 * スクロールするのは document ではなく画面の中の要素なので、すべての要素の内容の高さを見る
 */
const capture = async (
  app: App,
  browser: Browser,
  viewport: (typeof VIEWPORTS)[number],
  name: string,
) => {
  const { width, height, label } = viewport;
  const contentHeight = await browser.evaluate(() =>
    Math.max(...[...document.querySelectorAll("*")].map((element) => element.scrollHeight)),
  );
  await browser.setViewport({ width, height: Math.max(height, contentHeight) });
  const path = await app.screenshot(name);
  await browser.setViewport({ width, height });
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await copyFile(path, `${SCREENSHOT_DIR}/${name}-${label}.png`);
};

/** 手元の D1 と UserDO は実行のあいだで残るので、途中で止まった実行のセッションが残っていれば終了する */
const endLeftoverSession = async (screen: Screen) => {
  const end = screen.getByRole("button", { name: "終了" });
  const start = screen.getByRole("button", { name: START_BUTTON });
  await expect.poll(async () => (await end.isVisible()) || (await start.isVisible())).toBe(true);
  if (await end.isVisible()) {
    await end.tap();
  }
  await expect(start).toBeVisible();
};

/**
 * 主な画面を PC の幅とスマホの幅で撮る（docs/E2E.md「スクリーンショットを残す」）。
 * オーナーが手元で動かさずに画面を見られるよう、CI が artifact に載せる。
 * スタッツはサーバーが数えるので、ページの時計だけを進めるこのテストでは記録のない状態が写る。
 */
describe("主な画面のスクリーンショット", { serial: true, session: "screenshotTaker" }, () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.label}の幅で、ホーム・設定・スタッツ・タイマーの各フェーズを撮る`, async ({
      app,
      browser,
      screen,
    }) => {
      const shoot = (name: string) => capture(app, browser, viewport, name);
      await browser.setViewport({ width: viewport.width, height: viewport.height });
      await browser.addInitScript(installPageClock);
      await app.open("/");
      await endLeftoverSession(screen);
      await shoot("01-ホーム");

      await screen.getByRole("button", { name: "設定" }).tap();
      await expect(screen.getByRole("heading", { name: "設定", level: 1 })).toBeVisible();
      await shoot("02-設定");
      await screen.getByRole("button", { name: "タイマーに戻る" }).tap();

      await screen.getByRole("button", { name: "スタッツ" }).tap();
      await expect(screen.getByRole("heading", { name: "スタッツ", level: 1 })).toBeVisible();
      await shoot("03-スタッツ");
      await screen.getByRole("button", { name: "タイマーに戻る" }).tap();

      await screen.getByRole("button", { name: START_BUTTON }).tap();
      await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
      await shoot("04-集中");

      await advanceClock(browser, 7);
      await expect(screen.getByRole("heading", { name: "ジャーナル" })).toBeVisible();
      await shoot("05-ジャーナル");

      // 開始から24分で、3セット目のジャーナルが終わって休憩になる
      await advanceClock(browser, 17);
      await expect(screen.getByRole("heading", { name: "休憩" })).toBeVisible();
      await shoot("06-休憩");

      await screen.getByRole("button", { name: "終了" }).tap();
      await expect(screen.getByText("セッションを終了しました")).toBeVisible();
      await shoot("07-終了");
    });
  }
});
