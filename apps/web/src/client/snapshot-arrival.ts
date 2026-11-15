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

/**
 * 読み込めていない間に届いた同期メッセージのうち、いちばん新しいもの。
 * 時計のずれを測れていないので見せられず、読み込めたときに読み込みの結果と比べて反映する（Issue #52）
 */
type HeldSync =
  | Readonly<{ kind: "NothingHeld" }>
  | Readonly<{ kind: "Held"; snapshot: SessionSnapshot }>;

export type Loading =
  | Readonly<{ kind: "Loading"; held: HeldSync }>
  | Readonly<{ kind: "LoadFailed"; held: HeldSync }>
  | Readonly<{ kind: "Loaded"; received: Received }>;

const nothingHeld: HeldSync = { kind: "NothingHeld" };

/** 画面を開いたときの状態 */
export const initialLoading: Loading = { kind: "Loading", held: nothingHeld };

/** 「読み込み直す」。待たせている同期メッセージは、読み込み直しの結果と比べるために残す */
export const startReload = (current: Loading): Loading => {
  switch (current.kind) {
    case "Loading":
    case "LoadFailed":
      return { kind: "Loading", held: current.held };
    case "Loaded":
      return initialLoading;
  }
};

/** 待たせていた同期メッセージのほうが新しければ、そちらを見せる。時計のずれは読み込みで測ったもの */
const releaseHeld = (received: Received, held: HeldSync): Received => {
  switch (held.kind) {
    case "NothingHeld":
      return received;
    case "Held":
      return SessionSnapshot.isOlder(held.snapshot, received.snapshot)
        ? received
        : { snapshot: held.snapshot, offset: received.offset };
  }
};

/** 届いたスナップショットを反映する。手元より古いものは捨てる */
export const applyReceived = (current: Loading, received: Received): Loading => {
  switch (current.kind) {
    case "Loading":
    case "LoadFailed":
      return { kind: "Loaded", received: releaseHeld(received, current.held) };
    case "Loaded":
      return SessionSnapshot.isOlder(received.snapshot, current.received.snapshot)
        ? current
        : { kind: "Loaded", received };
  }
};

/**
 * 読み込み（`GET /api/session/current`）の応答を反映する。
 * 自分の操作と重なった読み込みは、操作の応答より古いかもしれないので、読み込めているなら捨てる（operation-overlap.ts）
 */
export const applyLoaded = (current: Loading, received: Received, overlapped: boolean): Loading =>
  overlapped && current.kind === "Loaded" ? current : applyReceived(current, received);

/** 読み込みに失敗した。読み込めていれば手元のまま */
export const applyLoadFailed = (current: Loading): Loading => {
  switch (current.kind) {
    case "Loading":
    case "LoadFailed":
      return { kind: "LoadFailed", held: current.held };
    case "Loaded":
      return current;
  }
};

/**
 * 同期メッセージで届いたスナップショットを反映する。送った時刻がわからないので時計のずれは測り直さず、
 * 直前に測ったものを使う。まだ読み込めていなければ、読み込めるまで待たせる
 */
export const applySynced = (current: Loading, snapshot: SessionSnapshot): Loading => {
  switch (current.kind) {
    case "Loading":
    case "LoadFailed":
      return { kind: current.kind, held: holdSynced(current.held, snapshot) };
    case "Loaded":
      return applyReceived(current, { snapshot, offset: current.received.offset });
  }
};

const holdSynced = (held: HeldSync, snapshot: SessionSnapshot): HeldSync => {
  switch (held.kind) {
    case "NothingHeld":
      return { kind: "Held", snapshot };
    case "Held":
      return SessionSnapshot.isOlder(snapshot, held.snapshot) ? held : { kind: "Held", snapshot };
  }
};
