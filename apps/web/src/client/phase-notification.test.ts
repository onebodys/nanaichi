import { describe, expect, test, vi } from "vite-plus/test";
import { showPhaseChangeNotification } from "./phase-notification.ts";

const journal = { kind: "Journal", round: 1, setNumber: 2 } as const;

/** 出した通知を記録する通知の出し先。Service Worker を登録できているかと、それぞれで出せるかを選ぶ */
const fakeNotifier = ({
  registered,
  serviceWorkerFails = false,
  pageFails = false,
}: Readonly<{ registered: boolean; serviceWorkerFails?: boolean; pageFails?: boolean }>) => {
  const fromServiceWorker = vi.fn(async (_title: string, _options?: NotificationOptions) => {
    if (serviceWorkerFails) {
      throw new TypeError("No active registration");
    }
  });
  const fromPage = vi.fn((_title: string, _options: NotificationOptions) => {
    if (pageFails) {
      throw new TypeError("Illegal constructor");
    }
  });
  return {
    fromServiceWorker,
    fromPage,
    notifier: {
      registration: async () => (registered ? { showNotification: fromServiceWorker } : undefined),
      showOnPage: fromPage,
    },
  };
};

describe("フェーズの切り替わりのブラウザ通知", () => {
  test("Service Worker を登録できていれば、Service Worker から通知を出す", async () => {
    const { fromServiceWorker, fromPage, notifier } = fakeNotifier({ registered: true });
    await showPhaseChangeNotification(journal, notifier);
    expect(fromServiceWorker).toHaveBeenCalledWith("ジャーナルの時間です", {
      body: "1ラウンド目・2セット目の振り返りと、次にやることの整理",
      tag: "nanaichi-phase-change",
      renotify: true,
      icon: "/icon-192.png",
    });
    expect(fromPage).not.toHaveBeenCalled();
  });

  test("Service Worker を登録できていなければ、ページから通知を出す", async () => {
    const { fromPage, notifier } = fakeNotifier({ registered: false });
    await showPhaseChangeNotification(journal, notifier);
    expect(fromPage).toHaveBeenCalledWith("ジャーナルの時間です", expect.anything());
  });

  test("Service Worker から出せなければ、ページから通知を出す", async () => {
    const { fromPage, notifier } = fakeNotifier({ registered: true, serviceWorkerFails: true });
    await showPhaseChangeNotification(journal, notifier);
    expect(fromPage).toHaveBeenCalledOnce();
  });

  test("どちらからも出せなくても例外にしない（音では知らせられる）", async () => {
    const { notifier } = fakeNotifier({
      registered: true,
      serviceWorkerFails: true,
      pageFails: true,
    });
    await expect(showPhaseChangeNotification(journal, notifier)).resolves.toBeUndefined();
  });
});
