import { FocusTime } from "./focus-time.ts";
import { Session } from "./session.ts";
import type { Ended, SetOutcome } from "./timer-state.ts";

/**
 * セッションのジャーナル記入の数。タイムラインを読み込むまでは数えられない。
 * 削除した記入は数えない（タイムラインに出ないため）
 */
export type EntryCount =
  | Readonly<{ kind: "Counted"; count: number }>
  | Readonly<{ kind: "NotYetCounted" }>;

/** セッションのまとめ（GLOSSARY の「セッションのまとめ」）。終了した直後のタイマーに出す */
export type SessionSummary = Readonly<{
  startedAt: Date;
  endedAt: Date;
  endedBy: Ended["endedBy"];
  /** 集中時間（ミリ秒） */
  focusTimeMs: number;
  completedSets: number;
  abortedSets: number;
  /** セットの結末を時刻の古い順に */
  sets: ReadonlyArray<SetOutcome>;
  entries: EntryCount;
}>;

export const SessionSummary = {
  /**
   * 終了したセッションのまとめ。
   *
   * セットの並びは `now`（終了を知った今の時刻）で計算する。自動終了は最後の記入・操作の時刻で
   * 閉じるので、その時刻で計算すると、まだ自動終了していない状態のセットの並びになってしまう。
   */
  of: (
    input: Readonly<{ session: Session; ended: Ended; now: Date; entries: EntryCount }>,
  ): SessionSummary => {
    const sets = Session.setOutcomesAt(input.session, input.now);
    return {
      startedAt: input.session.events[0].at,
      endedAt: input.ended.endedAt,
      endedBy: input.ended.endedBy,
      focusTimeMs: FocusTime.ofCompletedSets(input.ended.completedSets),
      completedSets: input.ended.completedSets,
      abortedSets: sets.filter((set) => set.kind === "AbortedSet").length,
      sets,
      entries: input.entries,
    };
  },
} as const;
