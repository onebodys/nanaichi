/// <reference lib="dom" />
// 偽物はページの中で動くので、ブラウザの型（DOM）を使う
import { describe, test, type Browser } from "@e2e-dev/web";
import { expect, type App } from "e2e";
import { advanceClock, installPageClock } from "./page-clock.ts";

/** 開始のボタン。終了したあとは「次のセッションを開始」になる */
const START_BUTTON = /^(次のセッションを)?開始$/;

/**
 * タイマー画面（Issue #5）。
 *
 * フェーズが自動で切り替わるのを本当に7分待たずに確かめるため、ページの時計（`Date.now`）を
 * 進められるようにする（tests/page-clock.ts）。画面は端末の時刻と時計のずれから残り時間を計算する（ADR 0003）ので、
 * ページの時計を進めればサーバーを待たずにフェーズが進む。
 * 音・通知・Wake Lock はヘッドレスのブラウザでは確かめられないので、呼ばれたことを記録する偽物に置き換える。
 */
const installFakes = () => {
  // 同じグループのテストでは初期化スクリプトが積み重なるので、2回目は何もしない
  if ("__recorded" in window) {
    return;
  }
  const recorded: Recorded = { notifications: [], tones: 0, wakeLocks: [] };
  Object.assign(window, { __recorded: recorded });
  // 知らせ方の設定は端末に残るので、前のテストで変えたものを持ち越さない
  localStorage.removeItem("nanaichi:alert-settings");

  class FakeNotification {
    static permission: NotificationPermission = "default";
    static async requestPermission() {
      FakeNotification.permission = "granted";
      return FakeNotification.permission;
    }
    constructor(title: string, options?: NotificationOptions) {
      recorded.notifications.push({ title, body: options?.body ?? "" });
    }
  }
  Object.assign(window, { Notification: FakeNotification });

  // 音を鳴らしたかを数える（画面は音を合成するたびに Oscillator を作る）
  class CountingAudioContext extends AudioContext {
    override createOscillator() {
      recorded.tones += 1;
      return super.createOscillator();
    }
  }
  Object.assign(window, { AudioContext: CountingAudioContext });

  Object.defineProperty(navigator, "wakeLock", {
    value: {
      request: async () => {
        recorded.wakeLocks.push("acquired");
        const sentinel = {
          released: false,
          release: async () => {
            sentinel.released = true;
            recorded.wakeLocks.push("released");
          },
        };
        return sentinel;
      },
    },
  });
};

/** 偽物が記録したもの（ページの `window.__recorded`） */
type Recorded = {
  notifications: Array<{ title: string; body: string }>;
  tones: number;
  wakeLocks: Array<"acquired" | "released">;
};

const recordedIn = (browser: Browser) => browser.evaluate<Recorded>("window.__recorded");

/** フェーズの進め方の既定（すべて自動） */
const ALL_AUTO = {
  FocusToJournal: "Auto",
  JournalToFocus: "Auto",
  JournalToBreak: "Auto",
  BreakToFocus: "Auto",
} as const;

/**
 * 前の実行のセッションが残っていれば終了しておき（UserDO の状態は実行のあいだで残る、docs/E2E.md）、
 * フェーズの進め方を既定のすべて自動に戻し、偽物を入れてからセッションなしの画面を開く。
 * API はブラウザの cookie を付けてテストから呼ぶ。
 */
const openWithoutSession = async (app: App, browser: Browser) => {
  const baseUrl = app.baseUrl ?? "http://localhost:5173";
  const cookie = (await browser.cookies()).map(({ name, value }) => `${name}=${value}`).join("; ");
  await fetch(new URL("/api/settings/advance-mode", baseUrl), {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(ALL_AUTO),
  });
  const current: unknown = await (
    await fetch(new URL("/api/session/current", baseUrl), { headers: { cookie } })
  ).json();
  if (
    typeof current === "object" &&
    current !== null &&
    "kind" in current &&
    current.kind === "Session"
  ) {
    await fetch(new URL("/api/session/commands", baseUrl), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), kind: "End" }),
    });
  }
  await browser.addInitScript(installPageClock);
  await browser.addInitScript(installFakes);
  await app.open("/");
};

// どのテストも同じユーザーのセッションを使うので、並べて走らせない
describe("タイマー画面", { serial: true, session: "signedIn" }, () => {
  test("セッションを開始すると、1ラウンド目・1セット目の集中のカウントダウンが始まる", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);

    await screen.getByRole("button", { name: START_BUTTON }).tap();

    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
    await expect(screen.getByText("1ラウンド目・1セット目")).toBeVisible();
    await expect(screen.getByLabel("残り時間")).toHaveText(/^[67]:\d\d$/);
    await expect(screen.getByRole("button", { name: "一時停止" })).toBeVisible();
    await expect(screen.getByRole("button", { name: "中断" })).toBeVisible();
    await expect(screen.getByRole("button", { name: "終了" })).toBeVisible();
    // 通知の許可はセッションの開始時に求める。セッション中は画面の消灯を防ぐ
    expect(await browser.evaluate(() => Notification.permission)).toBe("granted");
    await expect.poll(async () => (await recordedIn(browser)).wakeLocks).toEqual(["acquired"]);
  });

  test("時間が過ぎるとフェーズが自動で切り替わり、そのたびに音と通知で知らせる", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();

    const advance = (minutes: number) => advanceClock(browser, minutes);
    const recorded = () => recordedIn(browser);

    // 集中7分 → ジャーナル
    await advance(7);
    await expect(screen.getByRole("heading", { name: "ジャーナル" })).toBeVisible();
    await expect(screen.getByText("1ラウンド目・1セット目")).toBeVisible();
    await expect(screen.getByRole("button", { name: "中断" })).toHaveCount(0);
    await expect
      .poll(async () => (await recorded()).notifications.map((n) => n.title))
      .toEqual(["ジャーナルの時間です"]);
    expect((await recorded()).tones).toBeGreaterThan(0);

    // ジャーナル1分 → 2セット目の集中
    await advance(1);
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
    await expect(screen.getByText("1ラウンド目・2セット目")).toBeVisible();

    // 3セット目のジャーナルが終わると休憩（開始から24分）
    await advance(16);
    await expect(screen.getByRole("heading", { name: "休憩" })).toBeVisible();
    await expect(screen.getByRole("button", { name: "休憩をスキップ" })).toBeVisible();

    await expect
      .poll(async () => (await recorded()).notifications.map((n) => n.title))
      .toEqual(["ジャーナルの時間です", "集中の時間です", "休憩の時間です"]);

    await screen.getByRole("button", { name: "終了" }).tap();
    await expect(screen.getByText("セッションを終了しました")).toBeVisible();
  });

  test("音を鳴らさない設定にすると、フェーズが切り替わっても音は鳴らさず通知だけ出す", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: "設定" }).tap();
    await screen.getByRole("switch", { name: "音で知らせる" }).tap();
    await screen.getByRole("button", { name: "タイマーに戻る" }).tap();
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();

    await advanceClock(browser, 7);
    await expect(screen.getByRole("heading", { name: "ジャーナル" })).toBeVisible();
    await expect
      .poll(async () => (await recordedIn(browser)).notifications.map((n) => n.title))
      .toEqual(["ジャーナルの時間です"]);
    expect((await recordedIn(browser)).tones).toBe(0);

    await screen.getByRole("button", { name: "終了" }).tap();
    await expect(screen.getByText("セッションを終了しました")).toBeVisible();
  });

  test("ブラウザ通知を出さない設定にすると、開始しても通知の許可を求めず、切り替わりは音だけで知らせる", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: "設定" }).tap();
    await screen.getByRole("switch", { name: "ブラウザ通知" }).tap();
    await screen.getByRole("button", { name: "タイマーに戻る" }).tap();
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
    expect(await browser.evaluate(() => Notification.permission)).toBe("default");

    await advanceClock(browser, 7);
    await expect(screen.getByRole("heading", { name: "ジャーナル" })).toBeVisible();
    await expect.poll(async () => (await recordedIn(browser)).tones).toBeGreaterThan(0);
    expect((await recordedIn(browser)).notifications).toEqual([]);

    await screen.getByRole("button", { name: "終了" }).tap();
    await expect(screen.getByText("セッションを終了しました")).toBeVisible();
  });

  test("設定画面を開いたままでも、時間が過ぎるとフェーズが切り替わり、音と通知で知らせる", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: START_BUTTON }).tap();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();

    await screen.getByRole("button", { name: "設定" }).tap();
    await expect(screen.getByRole("heading", { name: "設定", level: 1 })).toBeVisible();
    await expect(screen.getByText(/^集中 [67]:\d\d$/)).toBeVisible();

    await advanceClock(browser, 7);
    // 設定画面のヘッダーに、裏で進んでいるタイマーが出る
    await expect(screen.getByText(/^ジャーナル [01]:\d\d$/)).toBeVisible();
    await expect
      .poll(async () => (await recordedIn(browser)).notifications.map((n) => n.title))
      .toEqual(["ジャーナルの時間です"]);
    expect((await recordedIn(browser)).tones).toBeGreaterThan(0);

    await screen.getByRole("button", { name: "タイマーに戻る" }).tap();
    await expect(screen.getByRole("heading", { name: "ジャーナル" })).toBeVisible();
    await screen.getByRole("button", { name: "終了" }).tap();
    await expect(screen.getByText("セッションを終了しました")).toBeVisible();
  });

  test("集中 → ジャーナルを手動にすると、集中の時間が過ぎたら 0:00 で止まって知らせ、ジャーナルを始めるボタンを出す", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: "設定" }).tap();
    const focusToJournal = screen.getByRole("group", { name: "集中 → ジャーナルの進め方" });
    // 選択肢のラジオボタンは見た目の上ではラベルに覆われているので、ラベルの文字を押す
    await focusToJournal.getByText("手動", { exact: true }).tap();
    await expect(focusToJournal.getByRole("radio", { name: "手動" })).toBeChecked();

    // アカウントの設定なので、開き直してもサーバーから読んだ値が手動のまま
    await browser.reload();
    await expect(
      screen
        .getByRole("group", { name: "集中 → ジャーナルの進め方" })
        .getByRole("radio", { name: "手動" }),
    ).toBeChecked();
    await screen.getByRole("button", { name: "タイマーに戻る" }).tap();

    await screen.getByRole("button", { name: START_BUTTON }).tap();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();

    await advanceClock(browser, 9);
    await expect(screen.getByRole("heading", { name: "切り替え待ち" })).toBeVisible();
    await expect(screen.getByLabel("残り時間")).toHaveText("0:00");
    await expect(screen.getByText(/^集中が終わりました · 2分0\d秒前$/)).toBeVisible();
    await expect(screen.getByRole("button", { name: "ジャーナルを始める" })).toBeVisible();
    await expect(screen.getByRole("button", { name: "一時停止" })).toHaveCount(0);
    // 切り替え待ちになったときに、移る先のジャーナルとして知らせる
    await expect
      .poll(async () => (await recordedIn(browser)).notifications.map((n) => n.title))
      .toEqual(["ジャーナルの時間です"]);
    expect((await recordedIn(browser)).tones).toBeGreaterThan(0);

    // ページの時計だけを進めているので、サーバーではまだ集中中。「ジャーナルを始める」を押した結果は
    // 結合テスト（advance-mode-api.workers.test.ts）と、本当の時計で動かした確認で確かめる
    await screen.getByRole("button", { name: "終了" }).tap();
    await expect(screen.getByText("セッションを終了しました")).toBeVisible();

    // 自動に戻しておく
    await screen.getByRole("button", { name: "設定" }).tap();
    await screen
      .getByRole("group", { name: "集中 → ジャーナルの進め方" })
      .getByText("自動", { exact: true })
      .tap();
    await expect(
      screen
        .getByRole("group", { name: "集中 → ジャーナルの進め方" })
        .getByRole("radio", { name: "自動" }),
    ).toBeChecked();
  });

  test("一時停止・再開・中断・集中の再開始・終了のボタンが状態に応じて出し分けられ、操作では通知しない", async ({
    app,
    browser,
    screen,
  }) => {
    await openWithoutSession(app, browser);
    await screen.getByRole("button", { name: START_BUTTON }).tap();

    await screen.getByRole("button", { name: "一時停止" }).tap();
    await expect(screen.getByText("一時停止中")).toBeVisible();
    await expect(screen.getByRole("button", { name: "一時停止" })).toHaveCount(0);

    await screen.getByRole("button", { name: "再開" }).tap();
    await expect(screen.getByText("一時停止中")).toHaveCount(0);

    await screen.getByRole("button", { name: "中断" }).tap();
    await expect(screen.getByRole("heading", { name: "待機" })).toBeVisible();
    await expect(screen.getByLabel("残り時間")).toHaveCount(0);

    await screen.getByRole("button", { name: "集中を再開始" }).tap();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
    await expect(screen.getByText("1ラウンド目・1セット目")).toBeVisible();

    await screen.getByRole("button", { name: "終了" }).tap();
    await expect(screen.getByText("セッションを終了しました")).toBeVisible();
    await expect(screen.getByRole("button", { name: START_BUTTON })).toBeVisible();

    const recorded = await recordedIn(browser);
    expect(recorded.notifications).toEqual([]);
    // 終了すると画面の消灯を防ぐのをやめる
    expect(recorded.wakeLocks.at(-1)).toBe("released");
  });
});
