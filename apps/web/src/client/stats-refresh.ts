import { localDateIn } from "../domain/local-date.ts";
import type { TimerView } from "./use-session-timer.ts";

/**
 * スタッツを読み込み直すきっかけ（ADR 0014）。この値が変わったときにだけ読み込み直す。
 *
 * 完了セットが増えるのは集中を終えたときだけなので、今日の日付・現在のセッション・その完了セット数・
 * 終了したかを見ていれば、数が変わる時点をすべて捉えられる。他の端末での操作も、同期メッセージで
 * タイマーのスナップショットが変わるので、ここに表れる。
 */
export const statsRefreshKeyOf = (timer: TimerView, serverNow: Date, timeZone: string): string => {
  const today = localDateIn(timeZone)(serverNow).key;
  switch (timer.kind) {
    case "Loading":
    case "LoadFailed":
    case "NoSession":
      return `${today}|${timer.kind}`;
    case "InSession":
    case "Ended":
      return `${today}|${timer.kind}|${timer.session.id}|${timer.state.completedSets}`;
  }
};
