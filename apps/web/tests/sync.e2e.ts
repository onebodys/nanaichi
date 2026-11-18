/// <reference lib="dom" />
// WebSocket の差し替えはページの中で動くので、ブラウザの型（DOM）を使う
import { describe, test, type Browser } from "@e2e-dev/web";
import { expect, type App } from "e2e";

/** 開始のボタン。終了したあとは「次のセッションを開始」になる */
const START_BUTTON = /^(次のセッションを)?開始$/;

/**
 * 複数タブ・複数デバイスの同期（Issue #7、ADR 0012）。
 *
 * ブラウザで開いた画面を「スマホ」とし、テストから同じユーザーの cookie で API を直接呼んで
 * 「PC での操作・記入」とする。スマホの画面は読み込み直さずに、同期メッセージだけで変わることを確かめる。
 */
const asOtherDevice = async (app: App, browser: Browser) => {
  const baseUrl = app.baseUrl ?? "http://localhost:5173";
  const cookie = (await browser.cookies()).map(({ name, value }) => `${name}=${value}`).join("; ");
  const send = (method: string, path: string, body?: unknown) =>
    fetch(new URL(path, baseUrl), {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    operate: (kind: string) =>
      send("POST", "/api/session/commands", { id: crypto.randomUUID(), kind }),
    start: () => send("POST", "/api/session", { id: crypto.randomUUID() }),
    write: (id: string, body: string) => send("POST", "/api/journal-entries", { id, body }),
    edit: (id: string, body: string) =>
      send("PATCH", `/api/journal-entries/${id}`, { body, tags: [] }),
    remove: (id: string) => send("DELETE", `/api/journal-entries/${id}`),
  };
};

/**
 * ページの同期の WebSocket を、テストから切断できるように差し替える。`__disconnect()` で開いている接続を閉じ、
 * `__reconnect()` を呼ぶまでは繋ぎ直しても繋がらない（繋がらない宛先に向ける）。
 *
 * `__settled()` は、同期の接続が開いていて、読み込み中の API がないときに true を返す。画面は繋がったときに
 * スナップショットとタイムラインを読み込み直すので、その応答が切断のあとに返ると、切断している間の
 * PC の操作が画面に届いてしまう。切断する前にこれを待つ。
 *
 * `__loseNextResponse(method, path)` は、次にその API を呼んだとき、要求はサーバーに届けたうえで応答を
 * 捨て、通信できなかったことにする（UserDO は処理を終えたが、画面には届かない。Issue #53）。
 */
const installDisconnectableSocket = () => {
  if ("__disconnect" in window) {
    return;
  }
  const RealWebSocket = WebSocket;
  const sockets: Array<WebSocket> = [];
  let blocked = false;
  let pendingRequests = 0;
  const toLose: Array<{ method: string; path: string }> = [];
  const realFetch = window.fetch;
  window.fetch = async (...args) => {
    pendingRequests += 1;
    try {
      const response = await realFetch(...args);
      const method = (args[1]?.method ?? "GET").toUpperCase();
      const [input] = args;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, location.href).pathname;
      const lost = toLose.findIndex((r) => r.method === method && r.path === path);
      if (lost >= 0) {
        toLose.splice(lost, 1);
        throw new TypeError("Failed to fetch");
      }
      return response;
    } finally {
      pendingRequests -= 1;
    }
  };
  window.WebSocket = class extends RealWebSocket {
    constructor(url: string | URL, protocols?: string | Array<string>) {
      // 同期の接続だけを扱う。開発サーバー（Vite）の接続まで閉じると、ページが読み込み直される
      const sync = String(url).endsWith("/api/ws");
      super(sync && blocked ? "ws://127.0.0.1:9/" : url, protocols);
      if (sync) {
        sockets.push(this);
      }
    }
  };
  Object.assign(window, {
    __settled: () =>
      pendingRequests === 0 && sockets.some((socket) => socket.readyState === RealWebSocket.OPEN),
    __disconnect: () => {
      blocked = true;
      for (const socket of sockets.splice(0)) {
        socket.close();
      }
    },
    __loseNextResponse: (method: string, path: string) => {
      toLose.push({ method, path });
    },
    __reconnect: () => {
      blocked = false;
      // オンラインに戻ったときと同じく、繋ぎ直しを待たずにすぐ繋ぐ
      window.dispatchEvent(new Event("online"));
    },
  });
};

// どのテストも同じユーザーのセッションを使うので、並べて走らせない
describe("複数の端末の同期", { serial: true, session: "syncWatcher" }, () => {
  test("PC で開始・一時停止・終了すると、開いているスマホの画面にすぐ反映される", async ({
    app,
    browser,
    screen,
  }) => {
    const pc = await asOtherDevice(app, browser);
    // 前の実行のセッションが残っていれば終了しておく（docs/E2E.md）
    await pc.operate("End");
    await app.open("/");
    await expect(screen.getByRole("button", { name: START_BUTTON })).toBeVisible();

    await pc.start();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
    await expect(screen.getByText("1ラウンド目・1セット目")).toBeVisible();

    await pc.operate("Pause");
    await expect(screen.getByRole("button", { name: "再開" })).toBeVisible();

    await pc.operate("End");
    await expect(screen.getByText("セッションを終了しました")).toBeVisible();
  });

  test("PC で書いた・編集した・削除したジャーナル記入が、スマホのタイムラインにすぐ反映される", async ({
    app,
    browser,
    screen,
  }) => {
    const pc = await asOtherDevice(app, browser);
    await pc.operate("End");
    await app.open("/");
    await expect(screen.getByRole("button", { name: START_BUTTON })).toBeVisible();
    await pc.start();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();
    const id = crypto.randomUUID();
    const entry = screen.getByRole("listitem", { name: "ジャーナル記入" }).first();

    await pc.write(id, "PC で書いた記入");
    await expect(entry).toContainText("PC で書いた記入");
    await expect(entry).toContainText("1ラウンド目・1セット目・集中");

    await pc.edit(id, "PC で書き直した記入");
    await expect(entry).toContainText("PC で書き直した記入");
    await expect(entry).toContainText("編集済み");

    await pc.remove(id);
    await expect(screen.getByText("PC で書き直した記入")).toHaveCount(0);

    await pc.operate("End");
  });

  test("切断している間に PC で変えた内容は、繋ぎ直したときにスマホが読み込み直して反映される", async ({
    app,
    browser,
    screen,
  }) => {
    const pc = await asOtherDevice(app, browser);
    await pc.operate("End");
    await browser.addInitScript(installDisconnectableSocket);
    await app.open("/");
    await expect(screen.getByRole("button", { name: START_BUTTON })).toBeVisible();
    await pc.start();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();

    // ローカルの記録は実行のあいだで残るので、前の実行の記入と見分けられる本文にする
    const body = `切断中に PC で書いた記入 ${crypto.randomUUID().slice(0, 8)}`;

    await expect.poll(() => browser.evaluate<boolean>("window.__settled()")).toBe(true);
    await browser.evaluate<null>("(window.__disconnect(), null)");
    await pc.operate("Pause");
    await pc.write(crypto.randomUUID(), body);
    // 切れている間は届かない
    await expect(screen.getByRole("button", { name: "一時停止" })).toBeVisible();
    await expect(screen.getByText(body)).toHaveCount(0);

    await browser.evaluate<null>("(window.__reconnect(), null)");
    await expect(screen.getByRole("button", { name: "再開" })).toBeVisible();
    await expect(screen.getByText(body)).toBeVisible();

    await pc.operate("End");
  });

  test("開始の応答が届かなくても、スマホは読み込み直して集中を見せる", async ({
    app,
    browser,
    screen,
  }) => {
    const pc = await asOtherDevice(app, browser);
    await pc.operate("End");
    await browser.addInitScript(installDisconnectableSocket);
    await app.open("/");
    await expect(screen.getByRole("button", { name: START_BUTTON })).toBeVisible();

    // 同期メッセージで届かないよう、切断しておく
    await expect.poll(() => browser.evaluate<boolean>("window.__settled()")).toBe(true);
    await browser.evaluate<null>("(window.__disconnect(), null)");
    await browser.evaluate<null>('(window.__loseNextResponse("POST", "/api/session"), null)');
    await screen.getByRole("button", { name: START_BUTTON }).click();

    await expect(
      screen.getByText("通信できませんでした。最新の状態を読み込み直します。"),
    ).toBeVisible();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();

    await browser.evaluate<null>("(window.__reconnect(), null)");
    await pc.operate("End");
  });

  test("繋ぎ直したときの読み込み直しの応答が届かなくても、間隔を空けて読み込み直し、PC で開始したセッションを見せる", async ({
    app,
    browser,
    screen,
  }) => {
    const pc = await asOtherDevice(app, browser);
    await pc.operate("End");
    await browser.addInitScript(installDisconnectableSocket);
    await app.open("/");
    await expect(screen.getByRole("button", { name: START_BUTTON })).toBeVisible();

    await expect.poll(() => browser.evaluate<boolean>("window.__settled()")).toBe(true);
    await browser.evaluate<null>("(window.__disconnect(), null)");
    await pc.start();
    await expect(screen.getByRole("button", { name: START_BUTTON })).toBeVisible();

    await browser.evaluate<null>(
      '(window.__loseNextResponse("GET", "/api/session/current"), null)',
    );
    await browser.evaluate<null>("(window.__reconnect(), null)");
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();

    await pc.operate("End");
  });
});
