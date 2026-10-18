import { Result } from "@praha/byethrow";
import {
  AdvanceMode,
  AdvanceModeChange,
  type LoadAdvanceModeChanges,
  type SaveAdvanceModeChange,
} from "../domain/advance-mode.ts";
import { schemaResult, type ValidationError } from "../domain/schema-result.ts";
import type { SessionSnapshot } from "../domain/session.ts";
import { getCurrentSession } from "./get-current-session.ts";
import type { OpenSessionDeps } from "./auto-end-session.ts";

export type ChangeAdvanceModeError = ValidationError;

export type ChangeAdvanceModeDeps = OpenSessionDeps &
  Readonly<{
    loadAdvanceModeChanges: LoadAdvanceModeChanges;
    saveAdvanceModeChange: SaveAdvanceModeChange;
  }>;

/**
 * 変えた結果。
 *
 * - `Changed`: 新しい進め方を記録した。`snapshot` は変えたあとの現在のセッション（進め方が状態を変えうる）
 * - `Unchanged`: いまと同じ進め方だったので、何も記録していない
 */
export type AdvanceModeChangeResult =
  | Readonly<{ kind: "Changed"; mode: AdvanceMode; snapshot: SessionSnapshot }>
  | Readonly<{ kind: "Unchanged"; mode: AdvanceMode }>;

/** `PUT /api/settings/advance-mode` の本文。4つの切り替わりの進め方をまとめて送る */
const parseInput = schemaResult(AdvanceMode.schema);

/**
 * フェーズの進め方を変える（GLOSSARY の「フェーズの進め方」、ADR 0016）。
 *
 * 入力の検証 → いまの進め方の読み込み → 同じなら何もしない → 変更の記録
 * → 変えたあとの現在のセッションの読み込み。セッションの途中でも、変えた時刻から効く。
 */
export const changeAdvanceMode =
  (deps: ChangeAdvanceModeDeps) =>
  (raw: unknown, now: Date): Result.Result<AdvanceModeChangeResult, ChangeAdvanceModeError> => {
    const change = (mode: AdvanceMode): AdvanceModeChangeResult => {
      const current = AdvanceModeChange.modeAt(deps.loadAdvanceModeChanges(), now);
      if (AdvanceMode.equals(current, mode)) {
        return { kind: "Unchanged", mode: current };
      }
      deps.saveAdvanceModeChange({ at: now, mode });
      return { kind: "Changed", mode, snapshot: getCurrentSession(deps)(now) };
    };

    return Result.pipe(parseInput(raw), Result.map(change));
  };
