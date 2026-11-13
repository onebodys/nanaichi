import { copyFile, mkdir } from "node:fs/promises";
import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

const START_BUTTON = /^(次のセッションを)?開始$/;

/** 撮った画面の置き場所。scripts/screenshot-gallery.ts がここから一覧の HTML を作る（tests/screenshots.e2e.ts と同じ） */
const SCREENSHOT_DIR = ".e2e/screenshots";

/**
 * ログインしないで記録したあと、ログインしてアカウントへ取り込む（ADR 0020）。
 * ブラウザの保存先はテストごとに空から始まる。手元の D1 と UserDO は実行のあいだで残るが、
 * 端末で発行する ID は毎回新しく、時刻も重ならないので、前の実行の記録とは混ざらない
 */
describe("この端末の記録をアカウントへ取り込む", () => {
  test("ログインしないで書いた記入が、ログインした直後の確かめで取り込むとアカウントのタイムラインに出る", async ({
    app,
    browser,
    screen,
  }) => {
    const body = `取り込む記入 ${crypto.randomUUID()}`;

    await app.open("/");
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    const input = screen.getByLabel("ジャーナル記入の本文");
    await expect(input).toBeEnabled();
    await input.pressSequentially(body);
    await input.press("Control+Enter");
    await expect(input).toHaveValue("");
    // 取り込めるのは閉じたセッションだけ
    await screen.getByRole("button", { name: "終了" }).tap();
    await expect(screen.getByRole("button", { name: START_BUTTON })).toBeVisible();

    await app.open("/api/test/sign-in?email=e2e-import%40example.com");
    await expect(browser).toHaveURL("/");
    // テスト用のログインは `/` に戻すので、ログイン画面の callbackURL と同じ印を付けて開き直す
    await app.open("/?from=login");

    const dialog = screen.getByRole("dialog", { name: "この端末の記録を取り込みますか？" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("1セッション・記入 1件");
    const path = await app.screenshot("取り込みの確かめ");
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    await copyFile(path, `${SCREENSHOT_DIR}/取り込みの確かめ-PC.png`);

    await dialog.getByRole("button", { name: "取り込む" }).tap();
    const finished = screen.getByRole("dialog", { name: "取り込みました" });
    await expect(finished).toContainText("1セッションをアカウントに取り込みました。");
    await finished.getByRole("button", { name: "閉じる" }).tap();

    await expect(
      screen.getByRole("listitem", { name: "ジャーナル記入" }).filter({ hasText: body }),
    ).toBeVisible();

    // 取り込んだ分はこの端末から消えるので、設定画面にも残りは出ない
    await screen.getByRole("button", { name: "設定" }).tap();
    await expect(screen.getByText("アカウントに取り込んでいない記録はありません")).toBeVisible();
  });
});
