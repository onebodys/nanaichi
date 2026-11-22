import { describe, test, type Browser } from "@e2e-dev/web";
import { expect, type App, type Screen } from "e2e";
import { advanceClock, installPageClock } from "./page-clock.ts";

/** 開始のボタン。終了したあとは「次のセッションを開始」になる */
const START_BUTTON = /^(次のセッションを)?開始$/;

// ジャーナル記入とタイムライン（Issue #6）。ジャーナルのフェーズに入るのを7分待たずに確かめるため、
// ページの時計（`Date.now`）を進める（tests/page-clock.ts）

/** 前の実行のセッションが残っていれば終了しておき（docs/E2E.md）、セッションなしの画面を開く */
const openWithoutSession = async (app: App, browser: Browser) => {
  const baseUrl = app.baseUrl ?? "http://localhost:5173";
  const cookie = (await browser.cookies()).map(({ name, value }) => `${name}=${value}`).join("; ");
  await fetch(new URL("/api/session/commands", baseUrl), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id: crypto.randomUUID(), kind: "End" }),
  });
  await browser.addInitScript(installPageClock);
  await app.open("/");
};

/** 送信キーを選ぶ。shadcn/ui の Select はネイティブの select ではないので、開いて選択肢を押す */
const chooseSubmitKey = async (screen: Screen, label: RegExp) => {
  await screen.getByRole("combobox", { name: "送信キー" }).tap();
  await screen.getByRole("option", { name: label }).tap();
};

/** 日付の区切りの見出し。新しい順に並ぶので、最初のものが今日 */
const dayHeadings = (screen: Screen) => screen.getByRole("heading", { name: /完了/, level: 3 });

/**
 * 今日の日付の区切りの数が確定するまで、タイムラインの続きを読み込む。
 *
 * 1日に1ページ分（10件）より多くのセッションがあると、今日を読み終えるまでは、今日の区切りに
 * サーバーが数えたスタッツの今日の数を出す（ADR 0011、0014）。このテストはページの時計だけを進めるので、
 * サーバーは集中を終えたことを知らず、その数は合わない。セッションは新しい順に読み込まれるので、
 * 昨日より前の区切りが出るか、続きがなくなれば、今日の分は読み終えていて、数はタイムラインから数えたものになる。
 */
const loadAllOfToday = async (screen: Screen) => {
  const more = screen.getByRole("button", { name: "さらに読み込む" });
  const loading = screen.getByRole("button", { name: "読み込み中…" });
  await expect(dayHeadings(screen).first()).toBeVisible();
  for (;;) {
    await expect(loading).toBeHidden();
    if ((await dayHeadings(screen).count()) > 1 || !(await more.isVisible())) {
      return;
    }
    // 続きはボタンが画面に入ると自動でも読み込まれる。押そうとして画面に入れると自動の読み込みが先に始まり、
    // ボタンが「読み込み中…」に変わって押せないことがあるが、そのときも続きは読み込まれるので、待って見直す
    await more.tap({ timeout: 2000 }).catch(() => undefined);
  }
};

const COMPLETED_SETS = /完了 (\d+)セット/;

/** 今日の日付の区切りに出ている完了セット数。今日の分を読み終えてから読む */
const completedSetsToday = async (screen: Screen): Promise<number> => {
  await loadAllOfToday(screen);
  const match = COMPLETED_SETS.exec((await dayHeadings(screen).first().textContent()) ?? "");
  if (match === null) {
    throw new Error("今日の日付の区切りに完了セット数が出ていない");
  }
  return Number(match[1]);
};

/** 日付の区切りの文言。集中時間は完了セット1つにつき7分（`完了 10セット · 集中 1時間10分`） */
const completedSetsText = (sets: number): string => {
  const minutes = sets * 7;
  const hours = Math.floor(minutes / 60);
  return `完了 ${sets}セット · 集中 ${hours === 0 ? "" : `${hours}時間`}${minutes % 60}分`;
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
    // ローカルの D1 は実行のあいだで残り、途中で止まった実行のセッションが走り続けて完了セットになっていることもある。
    // 今日の数は前の実行によるので、始めたときの数から1セット増えることを確かめる（docs/E2E.md）
    const before = await completedSetsToday(screen);
    // 集中中は入力欄からカーソルを外しておく
    await screen.getByRole("button", { name: "一時停止" }).focus();

    await advanceClock(browser, 7);

    await expect(screen.getByRole("heading", { name: "ジャーナル" })).toBeVisible();
    await expect(screen.getByLabel("ジャーナル記入の本文")).toBeFocused();
    await loadAllOfToday(screen);
    await expect(dayHeadings(screen).first()).toHaveText(
      new RegExp(`${completedSetsText(before + 1)}$`),
    );

    await screen.getByRole("button", { name: "終了" }).tap();
  });

  test("送っている間に書き足して送れなかった記入は帯に残り、同じ ID で送り直せ、入力欄に戻せ、セッションの外ではコピーだけできる", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    const input = screen.getByLabel("ジャーナル記入の本文");
    await expect(input).toBeEnabled();
    await chooseSubmitKey(screen, /\+Enter で送信$/);

    // 記入を書く要求を、合図があるまで止めてから落とす（送っている間に書き足すため）。`pass` の間は通す
    const posted: Array<string | undefined> = [];
    let mode: "fail" | "pass" = "fail";
    let release: () => void = () => undefined;
    const held = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    let gate = held();
    await browser.route(/\/api\/journal-entries$/, async (route) => {
      if (route.request.method !== "POST") {
        await route.fallback();
        return;
      }
      posted.push(route.request.postData);
      if (mode === "pass") {
        await route.continue();
        return;
      }
      await gate;
      gate = held();
      await route.abort();
    });

    const band = screen.getByRole("region", { name: "送れなかった記入" });
    const unsent = band.getByRole("listitem");

    // A を送っている間に B を書き、A が送れないと、入力欄に B が残り帯に A が出る
    await input.pressSequentially("送れない記入A");
    await input.press("Control+Enter");
    await expect(input).toHaveValue("");
    await input.pressSequentially("書き足したB");
    release();
    await expect(unsent).toHaveCount(1);
    await expect(unsent.first()).toContainText("送れない記入A");
    await expect(input).toHaveValue("書き足したB");

    // 帯に A を残したまま B を送り、送っている間に C を書くと、帯に2件並ぶ
    await input.press("Control+Enter");
    await input.pressSequentially("書き足したC");
    release();
    await expect(unsent).toHaveCount(2);
    await expect(unsent.nth(1)).toContainText("書き足したB");
    await expect(input).toHaveValue("書き足したC");

    // A を送り直すと、最初に送ったときと同じ ID・本文・タグで送り、帯から消える。B は残る
    mode = "pass";
    await unsent.first().getByRole("button", { name: "送り直す" }).tap();
    await expect(unsent).toHaveCount(1);
    await expect(unsent.first()).toContainText("書き足したB");
    expect(posted).toHaveLength(3);
    expect(JSON.parse(posted[2] ?? "")).toEqual(JSON.parse(posted[0] ?? ""));
    const entries = screen
      .getByRole("region", { name: /からのセッション$/ })
      .first()
      .getByRole("listitem", { name: "ジャーナル記入" });
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText("送れない記入A");

    // セッションが終わると送り直すことも入力欄に戻すこともできないが、本文は帯に残る
    await screen.getByRole("button", { name: "終了" }).tap();
    await expect(input).toBeDisabled();
    await expect(unsent.first().getByRole("button", { name: "送り直す" })).toBeDisabled();
    await expect(unsent.first().getByRole("button", { name: "入力欄に戻す" })).toBeDisabled();
    await expect(unsent.first()).toContainText("書き足したB");

    // 次のセッションで B を入力欄に戻すと、書き足した C の前に改行をはさんでつながり、帯が消える
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    await expect(input).toBeEnabled();
    await unsent.first().getByRole("button", { name: "入力欄に戻す" }).tap();
    await expect(input).toHaveValue("書き足したB\n書き足したC");
    await expect(band).toBeHidden();
    await browser.unroute(/\/api\/journal-entries$/);
    await input.fill("");
    await screen.getByRole("button", { name: "終了" }).tap();
  });

  test("前のセッションで送れなかった記入は次のセッションで送り直せず、入力欄に戻すか捨てられ、今のセッションで送れなかった記入は送り直せる", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    const input = screen.getByLabel("ジャーナル記入の本文");
    await expect(input).toBeEnabled();
    await chooseSubmitKey(screen, /\+Enter で送信$/);

    // 記入を書く要求を、合図があるまで止めてから落とす（送っている間に書き足すため）。`pass` の間は通す
    const posted: Array<string | undefined> = [];
    let mode: "fail" | "pass" = "fail";
    let release: () => void = () => undefined;
    const held = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    let gate = held();
    await browser.route(/\/api\/journal-entries$/, async (route) => {
      if (route.request.method !== "POST") {
        await route.fallback();
        return;
      }
      posted.push(route.request.postData);
      if (mode === "pass") {
        await route.continue();
        return;
      }
      await gate;
      gate = held();
      await route.abort();
    });
    const idOf = (body: string | undefined): unknown => JSON.parse(body ?? "").id;

    const band = screen.getByRole("region", { name: "送れなかった記入" });
    const unsent = band.getByRole("listitem");
    const PREVIOUS = "前のセッションの記入です";

    // S1 で A と B が送れず、帯に2件並ぶ
    await input.pressSequentially("前のA");
    await input.press("Control+Enter");
    await input.pressSequentially("前のB");
    release();
    await expect(unsent).toHaveCount(1);
    await input.press("Control+Enter");
    await input.pressSequentially("今のC");
    release();
    await expect(unsent).toHaveCount(2);
    await expect(unsent.first()).not.toContainText(PREVIOUS);

    // S1 を終えて S2 を始めると、A と B は前のセッションの記入で、送り直せないが、入力欄に戻すことと捨てることはできる
    await screen.getByRole("button", { name: "終了" }).tap();
    await expect(input).toBeDisabled();
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    await expect(input).toBeEnabled();
    for (const item of [unsent.nth(0), unsent.nth(1)]) {
      await expect(item).toContainText(PREVIOUS);
      await expect(item.getByRole("button", { name: "送り直す" })).toBeDisabled();
      await expect(item.getByRole("button", { name: "入力欄に戻す" })).toBeEnabled();
      await expect(item.getByRole("button", { name: "捨てる" })).toBeEnabled();
    }

    // S2 で C が送れないと帯に並び、A と B があっても C は送り直せる
    await input.press("Control+Enter");
    await input.pressSequentially("今のD");
    release();
    await expect(unsent).toHaveCount(3);
    const c = unsent.nth(2);
    await expect(c).toContainText("今のC");
    await expect(c).not.toContainText(PREVIOUS);
    await expect(c.getByRole("button", { name: "送り直す" })).toBeEnabled();
    mode = "pass";
    await c.getByRole("button", { name: "送り直す" }).tap();
    await expect(unsent).toHaveCount(2);
    expect(posted).toHaveLength(4);
    expect(JSON.parse(posted[3] ?? "")).toEqual(JSON.parse(posted[2] ?? ""));

    // B を捨てると帯から消える。A を入力欄に戻すと本文が入り、送ると A の ID ではなく新しい記入として S2 に書く
    await unsent.nth(1).getByRole("button", { name: "捨てる" }).tap();
    await expect(unsent).toHaveCount(1);
    await expect(unsent.first()).toContainText("前のA");
    await unsent.first().getByRole("button", { name: "入力欄に戻す" }).tap();
    await expect(band).toBeHidden();
    await expect(input).toHaveValue("前のA\n今のD");
    await input.press("Control+Enter");
    await expect(input).toHaveValue("");
    const current = screen.getByRole("region", { name: /からのセッション$/ }).first();
    await expect(current.getByRole("listitem", { name: "ジャーナル記入" })).toHaveCount(2);
    await expect(current).toContainText("前のA");
    expect(posted).toHaveLength(5);
    expect(idOf(posted[4])).not.toEqual(idOf(posted[0]));
    await browser.unroute(/\/api\/journal-entries$/);
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
