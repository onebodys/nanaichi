/**
 * 一定の間隔で `onTick` を呼び続ける。タイマー画面がカウントダウンを描き直し、
 * フェーズの切り替わりに気づくための刻み（Issue #45）。
 *
 * 画面のスレッドの `setInterval` は使わない。Chrome は、5分以上隠れていて音も鳴っていないタブの
 * タイマーを1分に1回までまとめる（Intensive wake-up throttling）。集中の7分を別のタブで過ごすと
 * この条件を満たし、切り替わりの音と通知が最大1分遅れる（ジャーナルの1分がほとんど残らない）。
 * Dedicated Worker のタイマーはこの対象外なので、Worker の中で刻んでメッセージで画面に知らせる。
 * メッセージの受け取りはまとめられない。
 */

/** 刻みを送る Worker のうち、使うところだけ */
type TickSource = Readonly<{
  onTick: (listener: () => void) => void;
  stop: () => void;
}>;

/** `intervalMs` ごとに刻む Worker を作る。作れなければ undefined（テストで差し替える。画面では `createWorkerTickSource`） */
export type CreateTickSource = (intervalMs: number) => TickSource | undefined;

/** Worker の中で動かすコード。届いた間隔で刻み続ける */
const WORKER_SOURCE = `onmessage = (event) => { setInterval(() => postMessage(0), event.data); };`;

/** ブラウザの Dedicated Worker で刻む。Worker のないブラウザや、作るのを拒まれたときは undefined */
const createWorkerTickSource: CreateTickSource = (intervalMs) => {
  if (typeof Worker === "undefined") {
    return undefined;
  }
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  // URL は Worker を止めるときに手放す（読み込みが終わる前に手放すと読めないブラウザがありうる）
  const release = () => URL.revokeObjectURL(url);
  try {
    const worker = new Worker(url);
    worker.postMessage(intervalMs);
    return {
      onTick: (listener) => worker.addEventListener("message", listener),
      stop: () => {
        worker.terminate();
        release();
      },
    };
  } catch {
    release();
    return undefined;
  }
};

/**
 * `intervalMs` ごとに `onTick` を呼び始め、止める関数を返す。
 * Worker を作れなければ画面のスレッドの `setInterval` で刻む（隠れたタブでは遅れうる）。
 */
export const startTicker = (
  intervalMs: number,
  onTick: () => void,
  createTickSource: CreateTickSource = createWorkerTickSource,
): (() => void) => {
  const source = createTickSource(intervalMs);
  if (source === undefined) {
    const timer = setInterval(onTick, intervalMs);
    return () => clearInterval(timer);
  }
  source.onTick(onTick);
  return source.stop;
};
