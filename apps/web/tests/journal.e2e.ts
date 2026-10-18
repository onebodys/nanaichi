/// <reference lib="dom" />
// 時計の差し替えはページの中で動くので、ブラウザの型（DOM）を使う
import { describe, test, type Browser } from "@e2e-dev/web";
import { expect, type App, type Screen } from "e2e";

/** 開始のボタン。終了したあとは「次のセッションを開始」になる */
const START_BUTTON = /^(次のセッションを)?開始$/;

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

/** 送信キーを選ぶ。shadcn/ui の Select はネイティブの select ではないので、開いて選択肢を押す */
const chooseSubmitKey = async (screen: Screen, label: RegExp) => {
  await screen.getByRole("combobox", { name: "送信キー" }).tap();
  await screen.getByRole("option", { name: label }).tap();
};

/**
 * 今日の日付の区切りに `expected` の完了セット数が出るまで、タイムラインの続きを読み込む。
 *
 * 1日に1ページ分（10件）より多くのセッションがあると、今日の区切りの数はタイムラインだけでは確定せず、
 * サーバーが数えたスタッツの今日の数を出す（ADR 0011、0014）。このテストはページの時計だけを進めるので、
 * サーバーは集中を終えたことを知らず、その数は合わない。ローカルの記録は実行のあいだで残り、今日のセッションは
 * 実行のたびに増えるので、何度走らせても確かめられるよう、タイムラインが今日の分を読み終えるまで続きを読み込む。
 */
const loadUntilTodayShows = async (screen: Screen, expected: RegExp) => {
  // 日付の区切りの見出しは新しい順に並ぶので、最初のものが今日
  const today = screen.getByRole("heading", { name: /完了/, level: 3 }).first();
  const more = screen.getByRole("button", { name: "さらに読み込む" });
  // 続きはボタンが画面に入ると自動でも読み込まれるので、読み込み中なら終わるのを待ってから見出しを読む
  const loaded = () => expect(screen.getByRole("button", { name: "読み込み中…" })).toBeHidden();
  await expect(today).toBeVisible();
  await loaded();
  while (!expected.test((await today.textContent()) ?? "") && (await more.isVisible())) {
    await more.tap();
    await loaded();
  }
  await expect(today).toHaveText(expected);
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

    await screen.getByRole("button", { name: START_BUTTON }).tap();
    await expect(input).toBeEnabled();

    await screen.getByRole("button", { name: "終了" }).tap();
    await expect(input).toBeDisabled();
  });

  test("既定の送信キーでは Enter で改行し Ctrl+Enter で送信する。送信すると空になり、続けて書けて、新しい記入が上に並ぶ", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    const input = screen.getByLabel("ジャーナル記入の本文");
    await expect(input).toBeEnabled();
    // 前のテストで選び直していても、既定に戻してから確かめる
    await chooseSubmitKey(screen, /\+Enter で送信$/);

    await input.pressSequentially("設計を書いた");
    await input.press("Enter");
    await input.pressSequentially("参考 https://example.com/e2e");
    await expect(input).toHaveValue("設計を書いた\n参考 https://example.com/e2e");
    // 修飾キーは ⌘ と Ctrl のどちらでも送るので、端末によらず Ctrl で確かめる
    await input.press("Control+Enter");
    await expect(input).toHaveValue("");

    await input.pressSequentially("続けて2件目");
    await input.press("Control+Enter");
    await expect(input).toHaveValue("");

    // ローカルの記録は実行のあいだで残るので、前の実行のセッションの記入を数えないよう、いちばん新しいセッションに絞る
    const entries = screen
      .getByRole("region", { name: /からのセッション$/ })
      .first()
      .getByRole("listitem", { name: "ジャーナル記入" });
    await expect(entries).toHaveCount(2);
    await expect(entries.first()).toContainText("続けて2件目");
    await expect(entries.nth(1)).toContainText("設計を書いた");
    await expect(entries.first()).toContainText("1ラウンド目・1セット目・集中");
    // URL だけがリンクになる
    await expect(
      entries.nth(1).getByRole("link", { name: "https://example.com/e2e" }),
    ).toHaveAttribute("href", "https://example.com/e2e");

    await screen.getByRole("button", { name: "終了" }).tap();
  });

  test("送信キーを Enter で送信に切り替えると Enter で送信し Shift+Enter で改行し、開き直しても覚えている", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    const input = screen.getByLabel("ジャーナル記入の本文");
    await expect(input).toBeEnabled();
    await chooseSubmitKey(screen, /^Enter で送信$/);

    await input.pressSequentially("1行目");
    await input.press("Shift+Enter");
    await input.pressSequentially("2行目");
    await expect(input).toHaveValue("1行目\n2行目");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    const entries = screen
      .getByRole("region", { name: /からのセッション$/ })
      .first()
      .getByRole("listitem", { name: "ジャーナル記入" });
    await expect(entries.first()).toContainText("1行目");

    await browser.reload();
    await expect(screen.getByRole("combobox", { name: "送信キー" })).toHaveText("Enter で送信");

    // 既定に戻しておく
    await chooseSubmitKey(screen, /\+Enter で送信$/);
    await screen.getByRole("button", { name: "終了" }).tap();
  });

  test("ジャーナルのフェーズに入ると入力欄にカーソルが置かれ、日付の区切りに完了セット数と集中時間が出る", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
    // 集中中は入力欄からカーソルを外しておく
    await screen.getByRole("button", { name: "一時停止" }).focus();

    await advanceClock(browser, 7);

    await expect(screen.getByRole("heading", { name: "ジャーナル" })).toBeVisible();
    await expect(screen.getByLabel("ジャーナル記入の本文")).toBeFocused();
    await loadUntilTodayShows(screen, /完了 1セット · 集中 7分$/);

    await screen.getByRole("button", { name: "終了" }).tap();
  });

  test("記入を編集・削除できる", async ({ app, browser, screen }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    const input = screen.getByLabel("ジャーナル記入の本文");
    // 開始がサーバーに受け付けられるまでは入力欄を使えない
    await expect(input).toBeEnabled();
    await input.pressSequentially("書き間違い");
    // Ctrl+Enter はどちらの送信キーでも送る
    await input.press("Control+Enter");
    const entry = screen.getByRole("listitem", { name: "ジャーナル記入" }).first();
    await expect(entry).toContainText("書き間違い");

    await entry.getByRole("button", { name: "編集" }).tap();
    const editor = screen.getByLabel("記入を編集");
    await editor.fill("書き直した");
    await editor.press("Control+Enter");
    await expect(entry).toContainText("書き直した");
    await expect(entry).toContainText("編集済み");

    // セッションを終えたあとでも削除できる
    await screen.getByRole("button", { name: "終了" }).tap();
    await entry.getByRole("button", { name: "削除" }).tap();
    await screen.getByRole("button", { name: "削除する" }).tap();
    await expect(screen.getByText("書き直した")).toHaveCount(0);
  });

  test("セッションの前にタグを準備して始めると、そのタグは送信しても外れず続けて書く記入にもつき、セッションを終えると外れる", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    const input = screen.getByLabel("ジャーナル記入の本文");
    const tagInput = screen.getByRole("combobox", { name: "タグ" });
    const chip = screen.getByRole("button", { name: "#e2e読書 を外す" });

    // セッションの外でも、これからやることとしてタグを準備できる。新しいタグは入力して Enter で作れる
    // （前の実行で使ったタグなら候補から選ばれる）
    await expect(input).toBeDisabled();
    await tagInput.tap();
    await tagInput.pressSequentially("#E2E読書");
    await tagInput.press("Enter");
    await expect(chip).toBeVisible();

    await screen.getByRole("button", { name: START_BUTTON }).tap();
    await expect(input).toBeEnabled();
    await expect(chip).toBeVisible();

    await input.pressSequentially("1章を読んだ");
    await input.press("Control+Enter");
    await expect(input).toHaveValue("");
    await input.pressSequentially("2章を読んだ");
    await input.press("Control+Enter");
    await expect(input).toHaveValue("");

    const entries = screen
      .getByRole("region", { name: /からのセッション$/ })
      .first()
      .getByRole("listitem", { name: "ジャーナル記入" });
    await expect(entries).toHaveCount(2);
    await expect(entries.first().getByRole("list", { name: "タグ" })).toHaveText("#e2e読書");
    await expect(entries.nth(1).getByRole("list", { name: "タグ" })).toHaveText("#e2e読書");

    // 開き直しても、同じセッションのあいだはつけたまま
    await browser.reload();
    await expect(chip).toBeVisible();

    await screen.getByRole("button", { name: "終了" }).tap();
    await expect(chip).toHaveCount(0);
  });

  test("記入を書いてからスタッツを開くと、今日のジャーナル記入として数えられ、期間を切り替えられる", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    const input = screen.getByLabel("ジャーナル記入の本文");
    await expect(input).toBeEnabled();
    await input.pressSequentially("スタッツに数えられる記入");
    await input.press("Control+Enter");
    await expect(input).toHaveValue("");

    await screen.getByRole("button", { name: "スタッツ" }).tap();
    await expect(screen.getByRole("heading", { name: "スタッツ", level: 1 })).toBeVisible();
    // 最初は週を開く
    await expect(browser).toHaveURL(/[?&]stats=Week/);
    await expect(screen.getByRole("radio", { name: "週" })).toBeChecked();

    // 選択肢のラジオボタンは見た目の上ではラベルに覆われているので、ラベルの文字を押す
    await screen.getByText("今日", { exact: true }).tap();
    await expect(browser).toHaveURL(/[?&]stats=Today/);
    await expect(screen.getByText("ジャーナル記入", { exact: true })).toBeVisible();
    await expect(screen.getByText(/^記入率 /)).toBeVisible();
    await expect(screen.getByText("この12週間")).toBeVisible();

    // Escape で閉じ、裏で進んでいたセッションの画面に戻る
    await screen.getByRole("radio", { name: "今日" }).press("Escape");
    await expect(screen.getByRole("heading", { name: "スタッツ", level: 1 })).toHaveCount(0);
    await screen.getByRole("button", { name: "終了" }).tap();
  });
});
