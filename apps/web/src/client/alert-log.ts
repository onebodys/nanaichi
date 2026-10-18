import type { TimerState } from "../domain/timer-state.ts";

/**
 * フェーズの切り替わりを知らせた記録（Issue #45 の調査用）。
 *
 * 「切り替わりの音が鳴ってすぐ画面を開いたのに、ジャーナルの残りが10秒しかない」という報告の原因を、
 * 実際に使っている端末で確かめるために残す。知らせるたびに、切り替わりの時刻から何秒遅れて気づいたか・
 * そのときタブが見えていたか・音を鳴らせる状態だったかを、端末の localStorage に直近の分だけ残す。
 *
 * - 遅れが大きく、タブが隠れていた → ブラウザが隠れたタブの処理を止めていた
 * - 遅れがほぼ 0 で、音が `running` でない → 気づいたのは間に合ったが、音だけが後から鳴った
 * - 遅れがほぼ 0 で、音も `running` → 知らせは間に合っている。残り時間の計算や表示の側を疑う
 *
 * 見るときは DevTools のコンソールで `JSON.parse(localStorage.getItem("nanaichi:alert-log"))`。
 */
export type AlertLogEntry = Readonly<{
  /** 知らせた端末の時刻（ISO 8601） */
  at: string;
  /** 移った先のフェーズ */
  to: "Focus" | "Journal" | "Break";
  /** 切り替わりの時刻から、気づいて知らせるまでの秒数。前の状態が一時停止中などで時刻がわからなければ null */
  lateSeconds: number | null;
  /** 知らせたときのタブの見え方（`document.visibilityState`） */
  visibility: DocumentVisibilityState;
  /** 知らせたときの音の状態。画面に触れる前で音を鳴らせなければ `Locked` */
  sound: AudioContextState | "Locked";
}>;

const STORAGE_KEY = "nanaichi:alert-log";
/** 残す件数。1日のセッションで切り替わる回数より十分多くする */
const MAX_ENTRIES = 100;

/**
 * 切り替わる直前の状態 `previous` と、気づいた時刻 `serverNow` から、何秒遅れて気づいたか。
 * 直前の状態が進んでいるフェーズなら、その終わりの時刻が切り替わりの時刻になる
 */
export const latenessSeconds = (previous: TimerState, serverNow: Date): number | null => {
  if (
    previous.kind === "Idle" ||
    previous.kind === "AwaitingAdvance" ||
    previous.kind === "Ended" ||
    previous.clock.kind !== "Running"
  ) {
    return null;
  }
  return Math.round((serverNow.getTime() - previous.clock.endsAt.getTime()) / 100) / 10;
};

/** 保存してある記録に `entry` を足し、古いものを捨てる。保存が壊れていれば作り直す */
export const appendAlertLog = (
  stored: string | null,
  entry: AlertLogEntry,
): ReadonlyArray<unknown> => {
  const parse = (): ReadonlyArray<unknown> => {
    try {
      const parsed: unknown = JSON.parse(stored ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return [...parse(), entry].slice(-MAX_ENTRIES);
};

/** 記録を残し、コンソールにも出す。localStorage を使えない端末では、コンソールに出すだけにする */
export const recordAlert = (entry: AlertLogEntry): void => {
  console.info("[nanaichi] フェーズの切り替わりを知らせた", entry);
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(appendAlertLog(localStorage.getItem(STORAGE_KEY), entry)),
    );
  } catch {
    // 記録は調査のためのもので、残せなくても知らせることは続ける
  }
};
