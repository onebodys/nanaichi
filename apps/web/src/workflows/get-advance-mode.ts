import { Result } from "@praha/byethrow";
import {
  AdvanceModeChange,
  type AdvanceMode,
  type LoadAdvanceModeChanges,
} from "../domain/advance-mode.ts";

export type GetAdvanceModeDeps = Readonly<{ loadAdvanceModeChanges: LoadAdvanceModeChanges }>;

/**
 * いまのフェーズの進め方を返す（`GET /api/settings/advance-mode`、ADR 0016）。
 * 変えたことがなければ既定（すべて自動）。想定内の失敗はない。
 */
export const getAdvanceMode =
  (deps: GetAdvanceModeDeps) =>
  (now: Date): Result.Result<AdvanceMode, never> =>
    Result.succeed(AdvanceModeChange.modeAt(deps.loadAdvanceModeChanges(), now));
