import type { ClockOffset } from "../domain/clock-offset.ts";
import { SessionSnapshot } from "../domain/session.ts";

/**
 * 届いたスナップショットを、タイマー画面の手元の状態にどう反映するか（ADR 0012）。
 *
 * 同じ変更が HTTP の応答と同期メッセージの両方で届き、届く順は入れ替わる。どの順で届いても画面が
 * 巻き戻らないことを、TLA+ のモデル（formal/session-sync/、スキル session-sync）で検査している。
 * ここを変えたらモデルも合わせる。
 */

/** 受け取ったスナップショットと、そのときに測った時計のずれ */
export type Received = Readonly<{ snapshot: SessionSnapshot; offset: ClockOffset }>;

export type Loading =
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "LoadFailed" }>
  | Readonly<{ kind: "Loaded"; received: Received }>;

/**
 * 届いたスナップショット（操作の応答、読み込みの応答）を反映する。手元より古いものは捨てる。
 * 自分の操作と重なった読み込みも同じく変更の番号で比べる（ADR 0030）。捨てると、その間の別の端末の
 * 変更を同期メッセージで受け取れていなかったときに、画面が古いまま残る（Issue #54）
 */
export const applyReceived = (current: Loading, received: Received): Loading =>
  current.kind === "Loaded" && SessionSnapshot.isOlder(received.snapshot, current.received.snapshot)
    ? current
    : { kind: "Loaded", received };

/** 読み込みに失敗した。読み込めていれば手元のまま */
export const applyLoadFailed = (current: Loading): Loading =>
  current.kind === "Loaded" ? current : { kind: "LoadFailed" };

/**
 * 同期メッセージで届いたスナップショットを反映する。送った時刻がわからないので時計のずれは測り直さず、
 * 直前に測ったものを使う。まだ読み込めていなければ捨てる（読み込みの結果を待つ）
 */
export const applySynced = (current: Loading, snapshot: SessionSnapshot): Loading =>
  current.kind === "Loaded"
    ? applyReceived(current, { snapshot, offset: current.received.offset })
    : current;
