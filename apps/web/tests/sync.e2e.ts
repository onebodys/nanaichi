/// <reference lib="dom" />
// WebSocket の差し替えはページの中で動くので、ブラウザの型（DOM）を使う
import { describe, test, type Browser } from "@e2e-dev/web";
import { expect, type App } from "e2e";

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
 */
const installDisconnectableSocket = () => {
  if ("__disconnect" in window) {
    return;
  }
  const RealWebSocket = WebSocket;
  const sockets: Array<WebSocket> = [];
  let blocked = false;
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
    __disconnect: () => {
      blocked = true;
      for (const socket of sockets.splice(0)) {
        socket.close();
      }
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
    await expect(screen.getByRole("button", { name: "開始" })).toBeVisible();

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
    await expect(screen.getByRole("button", { name: "開始" })).toBeVisible();
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
    await expect(screen.getByRole("button", { name: "開始" })).toBeVisible();
    await pc.start();
    await expect(screen.getByRole("heading", { name: "集中" })).toBeVisible();

    // ローカルの記録は実行のあいだで残るので、前の実行の記入と見分けられる本文にする
    const body = `切断中に PC で書いた記入 ${crypto.randomUUID().slice(0, 8)}`;

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
});
