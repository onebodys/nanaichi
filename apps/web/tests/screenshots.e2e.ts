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
 * ページの全体が写るように画面の高さを内容に合わせて撮り、再試行しても同じ名前になる場所へコピーする。
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

/**
 * 送っている間に書き足して送れなかった記入（入力欄の上の帯）を撮る（Issue #80）。
 * 記入を書く要求を、書き足すまで止めてから落とす。撮ったら帯の記入を捨て、入力欄を空に戻す
 */
const shootUnsentEntry = async (browser: Browser, screen: Screen, shoot: () => Promise<void>) => {
  await failWhileAppending(browser, screen);
  await shoot();
  await discardUnsent(screen);
};

/**
 * 前のセッションで送れなかった記入（Issue #88）を撮る。今のセッションで記入を送れずに帯に残し、
 * 終了して次のセッションを始めてから撮る。撮ったら帯の記入を捨て、入力欄を空に戻して終了する
 */
const shootPreviousSessionUnsentEntry = async (
  browser: Browser,
  screen: Screen,
  shoot: () => Promise<void>,
) => {
  await screen.getByRole("button", { name: START_BUTTON }).tap();
  await expect(screen.getByLabel("ジャーナル記入の本文")).toBeEnabled();
  await failWhileAppending(browser, screen);
  await screen.getByRole("button", { name: "終了" }).tap();
  await screen.getByRole("button", { name: START_BUTTON }).tap();
  await expect(screen.getByText("前のセッションの記入です", { exact: false })).toBeVisible();
  await shoot();
  await discardUnsent(screen);
  await screen.getByRole("button", { name: "終了" }).tap();
  await expect(screen.getByText("セッションを終了しました")).toBeVisible();
};

/** 記入を送っている間に書き足し、送れなかったことにして帯に1件残す */
const failWhileAppending = async (browser: Browser, screen: Screen) => {
  const pattern = /\/api\/journal-entries$/;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await browser.route(pattern, async (route) => {
    if (route.request.method !== "POST") {
      await route.fallback();
      return;
    }
    await gate;
    await route.abort();
  });
  const input = screen.getByLabel("ジャーナル記入の本文");
  await input.fill("設計のメモを書いた");
  await screen.getByRole("button", { name: "送信" }).tap();
  await expect(input).toHaveValue("");
  await input.fill("次はテストを足す");
  release();
  const band = screen.getByRole("region", { name: "送れなかった記入" });
  await expect(band.getByRole("listitem")).toHaveCount(1);
  await browser.unroute(pattern);
};

/** 帯の記入を捨て、入力欄を空に戻す */
const discardUnsent = async (screen: Screen) => {
  const band = screen.getByRole("region", { name: "送れなかった記入" });
  await band.getByRole("button", { name: "捨てる" }).tap();
  await expect(band).toBeHidden();
  await screen.getByLabel("ジャーナル記入の本文").fill("");
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

/** 設定画面で ToDo を使うかどうかを切り替え、ホームに戻る。すでにその設定なら切り替えない */
const setTaskSetting = async (screen: Screen, setting: "Enabled" | "Disabled") => {
  await screen.getByRole("button", { name: "設定" }).tap();
  const useTasks = screen.getByRole("switch", { name: "ToDo を使う" });
  await expect(useTasks).toBeVisible();
  if ((await useTasks.isChecked()) !== (setting === "Enabled")) {
    await useTasks.tap();
  }
  if (setting === "Enabled") {
    await expect(useTasks).toBeChecked();
  } else {
    await expect(useTasks).not.toBeChecked();
  }
  await screen.getByRole("button", { name: "タイマーに戻る" }).tap();
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
      // ToDo は設定で有効にしたときだけ出る（既定は無効）。手元の記録は残るので、まず無効にそろえて、従来の画面を撮る
      await setTaskSetting(screen, "Disabled");
      await shoot("01-ホーム");

      await screen.getByRole("button", { name: "設定" }).tap();
      await expect(screen.getByRole("heading", { name: "設定", level: 1 })).toBeVisible();
      await shoot("02-設定");
      await screen.getByRole("button", { name: "タイマーに戻る" }).tap();

      await screen.getByRole("button", { name: "スタッツ" }).tap();
      // 見出しは読み込みの前に出るので、読み込んだ内容が出てから撮る
      await expect(screen.getByText("この12週間")).toBeVisible();
      await shoot("03-スタッツ");
      // 記録がないときは、空の状態の案内にも同じ名前のボタンが出る
      await screen.getByRole("button", { name: "タイマーに戻る" }).first().tap();

      await screen.getByRole("button", { name: START_BUTTON }).tap();
      await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
      await shoot("04-集中");

      await advanceClock(browser, 7);
      await expect(screen.getByRole("heading", { name: "ジャーナル" })).toBeVisible();
      await shoot("05-ジャーナル");
      await shootUnsentEntry(browser, screen, () => shoot("05a-送れなかった記入"));

      // 開始から24分で、3セット目のジャーナルが終わって休憩になる
      await advanceClock(browser, 17);
      await expect(screen.getByRole("heading", { name: "休憩" })).toBeVisible();
      await shoot("06-休憩");

      await screen.getByRole("button", { name: "終了" }).tap();
      await expect(screen.getByText("セッションを終了しました")).toBeVisible();
      await shoot("07-終了");

      // ToDo を使う設定では、左ペインの上に簡略のタイマー、下に ToDo が並ぶ。手元の記録は残るので、写したらタスクを消して無効に戻す
      await setTaskSetting(screen, "Enabled");
      await screen.getByRole("textbox", { name: "タスクを追加" }).fill("ログイン画面のバグ修正");
      await screen.getByRole("button", { name: "追加" }).tap();
      await expect(screen.getByText("ログイン画面のバグ修正")).toBeVisible();
      await shoot("08-ToDo-終了");

      await screen.getByRole("button", { name: START_BUTTON }).tap();
      await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
      await shoot("09-ToDo-集中");

      await screen.getByRole("button", { name: "終了" }).tap();
      await expect(screen.getByText("セッションを終了しました")).toBeVisible();
      await screen
        .getByRole("listitem", { name: "未完了のタスク" })
        .getByRole("button", { name: "削除" })
        .tap();
      await expect(screen.getByText("未完了のタスクはありません")).toBeVisible();
      await setTaskSetting(screen, "Disabled");

      await shootPreviousSessionUnsentEntry(browser, screen, () =>
        shoot("10-前のセッションの送れなかった記入"),
      );
    });
  }
});
