import { describe, expect, test } from "vite-plus/test";
import type { TimerState } from "../domain/timer-state.ts";
import { appendAlertLog, latenessSeconds, type AlertLogEntry } from "./alert-log.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 18, 0, 7, seconds));

const focusEndingAt = (endsAt: Date): TimerState => ({
  kind: "Focus",
  round: 1,
  setNumber: 1,
  completedSets: 0,
  remainingSeconds: 0,
  clock: { kind: "Running", endsAt },
});

const entry = (to: AlertLogEntry["to"]): AlertLogEntry => ({
  at: at(0).toISOString(),
  to,
  lateSeconds: 0,
  visibility: "hidden",
  sound: "running",
});

describe("知らせた記録の遅れ", () => {
  test("集中の終わりの時刻から、ジャーナルへの切り替わりに気づくまでの秒数になる", () => {
    expect(latenessSeconds(focusEndingAt(at(0)), at(50))).toBe(50);
  });

  test("切り替わりの直後に気づけば、遅れは 1/10 秒の単位で 0 に近い", () => {
    expect(latenessSeconds(focusEndingAt(at(0)), new Date(at(0).getTime() + 240))).toBe(0.2);
  });

  test("直前が一時停止中なら、切り替わりの時刻がわからないので遅れは null", () => {
    const paused: TimerState = {
      kind: "Focus",
      round: 1,
      setNumber: 1,
      completedSets: 0,
      remainingSeconds: 120,
      clock: { kind: "Paused", pausedAt: at(0) },
    };
    expect(latenessSeconds(paused, at(50))).toBeNull();
  });

  test("直前が待機なら、遅れは null", () => {
    const idle: TimerState = { kind: "Idle", round: 1, setNumber: 1, completedSets: 0 };
    expect(latenessSeconds(idle, at(50))).toBeNull();
  });
});

describe("知らせた記録の保存", () => {
  test("保存がなければ、新しい記録1件だけになる", () => {
    expect(appendAlertLog(null, entry("Journal"))).toEqual([entry("Journal")]);
  });

  test("保存してある記録の後ろに足す", () => {
    const stored = JSON.stringify([entry("Journal")]);
    expect(appendAlertLog(stored, entry("Focus"))).toEqual([entry("Journal"), entry("Focus")]);
  });

  test("保存が壊れていれば、作り直して新しい記録1件だけになる", () => {
    expect(appendAlertLog("{broken", entry("Break"))).toEqual([entry("Break")]);
    expect(appendAlertLog('{"not":"array"}', entry("Break"))).toEqual([entry("Break")]);
  });

  test("100件を超えたら古いものから捨てる", () => {
    const stored = JSON.stringify(Array.from({ length: 100 }, () => entry("Journal")));
    const appended = appendAlertLog(stored, entry("Focus"));
    expect(appended).toHaveLength(100);
    expect(appended.at(-1)).toEqual(entry("Focus"));
  });
});
