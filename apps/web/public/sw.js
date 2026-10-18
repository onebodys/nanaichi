/*
 * nanaichi の Service Worker。フェーズの切り替わりのブラウザ通知を `registration.showNotification` で
 * 出すために入れている（client/phase-notification.ts）。Android の Chrome と、ホーム画面に追加した
 * iPhone の Web アプリは、Service Worker なしの通知（`new Notification`）を出せないため。
 *
 * 通信の横取り（fetch）とキャッシュはしない。タイマーはサーバーと同期して動くので、
 * オフラインで古い画面を出すより、毎回いまの画面を読み込むほうがよい。Web Push も使わない（docs/PRODUCT.md）。
 *
 * ビルドを通さず public/ からそのまま配信するので、素の JavaScript で書く。
 */

// 新しい版を配ったら、開いている画面を待たずにすぐ切り替える。キャッシュを持たないので切り替えても困らない
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// 通知を押したら、開いている nanaichi の画面を前に出す。閉じていれば開く
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const opened = windows.find((client) => "focus" in client);
      return opened === undefined ? self.clients.openWindow("/") : opened.focus();
    }),
  );
});
