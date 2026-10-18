import type { Phase } from "../domain/timer-state.ts";
import { phaseChangeMessageOf } from "./timer-text.ts";

/** 通知を出す先。テストでは差し替える */
type Notifier = Readonly<{
  /** 登録済みの Service Worker（public/sw.js）。登録できていなければ `undefined` */
  registration: () => Promise<Pick<ServiceWorkerRegistration, "showNotification"> | undefined>;
  /** Service Worker を通さずにページから通知を出す（`new Notification`） */
  showOnPage: (title: string, options: NotificationOptions) => void;
}>;

/**
 * 通知の出し方。`renotify` は TypeScript の型にまだないので足す。
 * 同じ tag の通知を置き換えたときも、音や振動でもう一度知らせる（つけないと、前の通知を消していなければ黙って置き換わる）
 */
type PhaseNotificationOptions = NotificationOptions & Readonly<{ renotify: boolean }>;

const browserNotifier: Notifier = {
  registration: async () =>
    "serviceWorker" in navigator ? navigator.serviceWorker.getRegistration() : undefined,
  showOnPage: (title, options) => {
    new Notification(title, options);
  },
};

/**
 * フェーズの切り替わりをブラウザ通知で知らせる。通知の許可は呼ぶ側で確かめる。
 *
 * Service Worker から出す（`registration.showNotification`）。Android の Chrome とホーム画面に追加した
 * iPhone の Web アプリは、Service Worker なしの通知を出せないため（#25）。
 * Service Worker を登録できていない・そこから出せなかったときは、ページから出す。
 * どちらでも出せなければあきらめる（音では知らせられる）。
 */
export const showPhaseChangeNotification = async (
  to: Phase,
  notifier: Notifier = browserNotifier,
): Promise<void> => {
  const { title, body } = phaseChangeMessageOf(to);
  const options: PhaseNotificationOptions = {
    body,
    // 同じ tag の通知は置き換わるので、切り替わりの通知が溜まらない
    tag: "nanaichi-phase-change",
    renotify: true,
    icon: "/icon-192.png",
  };
  const registration = await notifier.registration().catch(() => undefined);
  if (registration !== undefined) {
    try {
      await registration.showNotification(title, options);
      return;
    } catch {
      // ページからの通知を試す
    }
  }
  try {
    notifier.showOnPage(title, options);
  } catch {
    // Android の Chrome などは Service Worker なしの通知を例外にする。音では知らせられるので続ける
  }
};

/**
 * Service Worker（public/sw.js）を登録する。起動時に1度呼ぶ。
 * 登録できなくても（対応していないブラウザ・プライベートブラウズなど）、通知はページから出すので続ける
 */
export const registerServiceWorker = () => {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // showPhaseChangeNotification がページからの通知に戻る
  });
};
