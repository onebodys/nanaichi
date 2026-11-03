/// <reference lib="dom" />
// 時計の差し替えはページの中で動くので、ブラウザの型（DOM）を使う
import type { Browser } from "@e2e-dev/web";

/**
 * ページの時計（`Date.now`）を進められるようにする初期化スクリプト（docs/E2E.md「時間の経過・音・通知のテスト」）。
 * `browser.addInitScript(installPageClock)` で入れ、`advanceClock` で進める。
 *
 * 画面は API の往復の前後で読んだ `Date.now()` の中間で時計のずれを測る（ClockOffset.measure）。
 * 往復の途中で時計を進めると、進めた分の半分だけずれを誤って測り、フェーズが進まない。
 * また同期の WebSocket が繋がると画面はスナップショットを読み込み直し、そこで測り直したずれが
 * 進めた分を打ち消す。そのため時計は「同期の WebSocket が繋がっていて、通信の途中でない」ときにだけ進める。
 */
export const installPageClock = () => {
  // 同じグループのテストでは初期化スクリプトが積み重なるので、2回目は何もしない
  if ("__advanceClock" in window) {
    return;
  }

  // 通信の途中かを数える
  let inFlight = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    inFlight += 1;
    try {
      return await realFetch(...args);
    } finally {
      inFlight -= 1;
    }
  };

  // 開いている同期の WebSocket を数える
  let openSockets = 0;
  class CountingWebSocket extends WebSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      let opened = false;
      this.addEventListener("open", () => {
        opened = true;
        openSockets += 1;
      });
      this.addEventListener("close", () => {
        if (opened) {
          openSockets -= 1;
        }
      });
    }
  }
  Object.assign(window, { WebSocket: CountingWebSocket });

  // `Date` そのものを差し替えるとログインの判定まで巻き込むので、`now` だけにする
  const realNow = Date.now.bind(Date);
  let shift = 0;
  Date.now = () => realNow() + shift;

  const settled = (needsSocket: boolean) => (!needsSocket || openSockets > 0) && inFlight === 0;
  Object.assign(window, {
    __advanceClock: async (ms: number, needsSocket: boolean) => {
      // 繋がった直後の読み込みが始まる余地を残すため、落ち着いた状態が少し続くのを待つ
      let quietSince: number | undefined;
      while (quietSince === undefined || realNow() - quietSince < 200) {
        if (!settled(needsSocket)) {
          quietSince = undefined;
        } else if (quietSince === undefined) {
          quietSince = realNow();
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      shift += ms;
    },
  });
};

/**
 * ページの時計を `minutes` 分進める。同期の WebSocket が繋がり、通信が落ち着くのを待ってから進める。
 * この端末の記録先には同期の WebSocket がない（ADR 0019）ので、その画面では `{ socket: false }` を渡し、通信が落ち着くのだけを待つ
 */
export const advanceClock = (
  browser: Browser,
  minutes: number,
  { socket }: Readonly<{ socket: boolean }> = { socket: true },
) =>
  browser.evaluate<null>(`window.__advanceClock(${minutes * 60_000}, ${socket}).then(() => null)`);
