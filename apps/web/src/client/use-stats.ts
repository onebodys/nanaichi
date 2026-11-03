import { useEffect, useRef, useState } from "react";
import { Result } from "@praha/byethrow";
import type { StatsPeriod, StatsReport } from "../domain/stats.ts";
import { useBackend } from "./backend.ts";

/** 端末のタイムゾーン。スタッツの日付と時間帯はこのタイムゾーンで区切る（ADR 0014） */
export const deviceTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 画面に出すスタッツの様子。読み込み直している間は、前に読み込んだ同じ期間のものを出し続ける */
export type StatsView =
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "LoadFailed" }>
  | Readonly<{ kind: "Loaded"; report: StatsReport }>;

type Loaded = Readonly<{ period: StatsPeriod; report: StatsReport }>;

/**
 * 期間 `period` のスタッツ。`refreshKey`（`statsRefreshKeyOf`）が変わるたびに読み込み直す。
 * `enabled` が false の間は読み込まない（スタッツを閉じている間など）
 */
export const useStats = (period: StatsPeriod, refreshKey: string, enabled = true): StatsView => {
  const backend = useBackend();
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [failed, setFailed] = useState<StatsPeriod | undefined>(undefined);
  // 期間を続けて切り替えたとき、古い応答で新しい期間の表示を上書きしないよう、最後の読み込みだけを受け取る
  const latest = useRef(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    latest.current += 1;
    const request = latest.current;
    void backend.getStats(period, deviceTimeZone()).then((result) => {
      if (request !== latest.current) {
        return;
      }
      if (Result.isSuccess(result)) {
        setLoaded({ period, report: result.value });
        setFailed(undefined);
        return;
      }
      setFailed(period);
    });
  }, [backend, period, refreshKey, enabled]);

  if (loaded !== undefined && loaded.period === period) {
    return { kind: "Loaded", report: loaded.report };
  }
  return failed === period ? { kind: "LoadFailed" } : { kind: "Loading" };
};
