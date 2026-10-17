import { useEffect } from "react";

/**
 * `active` の間、Screen Wake Lock で画面の自動消灯を防ぐ（docs/PRODUCT.md「タイマー」）。
 *
 * ブラウザはタブが隠れると Wake Lock を手放すので、タブが見えるようになるたびに取り直す。
 * 対応していないブラウザや、電池残量が少ないなどで断られたときは何もしない（消灯を防げないだけ）。
 */
export const useWakeLock = (active: boolean): void => {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) {
      return;
    }
    let sentinel: WakeLockSentinel | undefined;
    let disposed = false;

    const acquire = async () => {
      if (
        document.visibilityState !== "visible" ||
        (sentinel !== undefined && !sentinel.released)
      ) {
        return;
      }
      try {
        const acquired = await navigator.wakeLock.request("screen");
        if (disposed) {
          await acquired.release();
          return;
        }
        sentinel = acquired;
      } catch {
        // 断られても画面が消灯しうるだけで、タイマーは動き続ける
      }
    };
    const onVisibilityChange = () => void acquire();

    void acquire();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void sentinel?.release();
    };
  }, [active]);
};
