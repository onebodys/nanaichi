import { phaseDurationMsOf } from "./timer-state.ts";

const FOCUS_MS = phaseDurationMsOf({ kind: "Focus", round: 1, setNumber: 1 });

/**
 * 集中時間（GLOSSARY の「集中時間」）。完了セットの集中の長さを足したもので、ミリ秒で持つ。
 *
 * 最後までやり切った集中だけを数えるので、不成立セットの集中や一時停止していた時間は含めない。
 * 完了セットの集中の長さは決まっているので、完了セット数から決まる。
 */
export const FocusTime = {
  ofCompletedSets: (completedSets: number): number => completedSets * FOCUS_MS,
} as const;
