/**
 * タイマー画面の読み込み（`GET /api/session/current`）が失敗したときのやり直し（Issue #53）。
 *
 * 読み込めている画面は、読み込み直しが失敗しても手元のスナップショットを見せ続ける（snapshot-arrival.ts の
 * `applyLoadFailed`）。そのままだと、失敗した読み込みが運ぶはずだった変更（同期の WebSocket が繋がる前に
 * 別の端末で開始した、など）は、次の変更か繋ぎ直しまで画面に届かない。
 * まだ読み込めていない画面も、失敗した読み込みより古い読み込みが後から届いて Loaded になれば、
 * 「読み込み直す」のボタンは出ない。
 * そこで、読み込みが失敗したら間隔を空けて読み込み直す。間隔は失敗が続くたびに倍にする（最大30秒）。
 *
 * TLA+ のモデル（formal/session-sync/、スキル session-sync）の `RetryLoad` に写している。ここを変えたらモデルも合わせる。
 */

/** 最初のやり直しまでの間隔。失敗が続くたびに倍にする */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** タイマーを張る・外す（テストで差し替える。画面ではブラウザの `setTimeout`） */
export type RetryTimers = Readonly<{
  set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
}>;

const browserTimers: RetryTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer),
};

export type LoadRetry = Readonly<{
  /** 読み込みが失敗した。やり直しを待っていなければ、間隔を空けて `load` を呼ぶ */
  failed: (load: () => void) => void;
  /** 読み込めた。次に失敗したら、また最初の間隔から */
  succeeded: () => void;
  /** 画面を閉じた。待っているやり直しをやめる */
  stop: () => void;
}>;

type Waiting =
  | Readonly<{ kind: "NotWaiting" }>
  | Readonly<{ kind: "Waiting"; timer: ReturnType<typeof setTimeout> }>;

export const createLoadRetry = (timers: RetryTimers = browserTimers): LoadRetry => {
  /** 続けて失敗した回数。読み込めたら 0 に戻す */
  let failures = 0;
  let waiting: Waiting = { kind: "NotWaiting" };
  return {
    failed: (load) => {
      failures += 1;
      switch (waiting.kind) {
        case "Waiting":
          return;
        case "NotWaiting": {
          const delay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
          const timer = timers.set(() => {
            waiting = { kind: "NotWaiting" };
            load();
          }, delay);
          waiting = { kind: "Waiting", timer };
          return;
        }
      }
    },
    succeeded: () => {
      failures = 0;
    },
    stop: () => {
      switch (waiting.kind) {
        case "NotWaiting":
          return;
        case "Waiting":
          timers.clear(waiting.timer);
          waiting = { kind: "NotWaiting" };
          return;
      }
    },
  };
};
