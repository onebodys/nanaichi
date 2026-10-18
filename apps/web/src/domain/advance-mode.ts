import * as v from "valibot";
import { JsonDateSchema } from "./json-date.ts";

/**
 * フェーズの進め方（GLOSSARY の「フェーズの進め方」、ADR 0016）。
 *
 * 4つの切り替わりごとに、時間が過ぎたら自動で次のフェーズに移るか（`Auto`）、
 * 切り替え待ちで止まって人が進めるまで待つか（`Manual`）を選ぶ。アカウントごとに1つ持つ。
 */
const PHASE_TRANSITIONS = [
  "FocusToJournal",
  "JournalToFocus",
  "JournalToBreak",
  "BreakToFocus",
] as const;
export type PhaseTransition = (typeof PHASE_TRANSITIONS)[number];

const AdvanceChoiceSchema = v.picklist(["Auto", "Manual"]);
export type AdvanceChoice = v.InferOutput<typeof AdvanceChoiceSchema>;

const AdvanceModeSchema = v.object({
  FocusToJournal: AdvanceChoiceSchema,
  JournalToFocus: AdvanceChoiceSchema,
  JournalToBreak: AdvanceChoiceSchema,
  BreakToFocus: AdvanceChoiceSchema,
});
export type AdvanceMode = Readonly<Record<PhaseTransition, AdvanceChoice>>;

/** 進め方を変えた時刻と、変えたあとの進め方 */
export type AdvanceModeChange = Readonly<{ at: Date; mode: AdvanceMode }>;

/** 既定はすべて自動（Issue #42。これまでと同じ動き） */
const ALL_AUTO = {
  FocusToJournal: "Auto",
  JournalToFocus: "Auto",
  JournalToBreak: "Auto",
  BreakToFocus: "Auto",
} as const satisfies AdvanceMode;

/** 移る前と移る先のフェーズの種類から、どの切り替わりか */
type PhaseKind = "Focus" | "Journal" | "Break";

const transitionOf = (from: PhaseKind, to: PhaseKind): PhaseTransition => {
  switch (from) {
    case "Focus":
      return "FocusToJournal";
    case "Journal":
      return to === "Break" ? "JournalToBreak" : "JournalToFocus";
    case "Break":
      return "BreakToFocus";
  }
};

export const AdvanceMode = {
  transitions: PHASE_TRANSITIONS,

  /** `PUT /api/settings/advance-mode` の本文と、その応答の検証に使う */
  schema: AdvanceModeSchema,

  default: ALL_AUTO,

  /** `from` のフェーズの時間が過ぎて `to` に移るとき、進め方は手動か */
  isManual: (mode: AdvanceMode, from: PhaseKind, to: PhaseKind): boolean =>
    mode[transitionOf(from, to)] === "Manual",

  equals: (a: AdvanceMode, b: AdvanceMode): boolean =>
    PHASE_TRANSITIONS.every((transition) => a[transition] === b[transition]),
} as const;

/** JSON にした進め方（`GET`・`PUT /api/settings/advance-mode` の応答）を検証して戻す（ADR 0009） */
export const AdvanceModeJsonSchema: v.GenericSchema<unknown, AdvanceMode> = AdvanceModeSchema;

export const AdvanceModeChangeJsonSchema: v.GenericSchema<unknown, AdvanceModeChange> = v.object({
  at: JsonDateSchema,
  mode: AdvanceModeSchema,
});

export const AdvanceModeChange = {
  /** 変更履歴 `changes`（時刻の順）のうち、時刻 `t` に効いている進め方。変更がなければ既定 */
  modeAt: (changes: ReadonlyArray<AdvanceModeChange>, t: Date): AdvanceMode =>
    changes.findLast((change) => change.at.getTime() <= t.getTime())?.mode ?? ALL_AUTO,

  /**
   * 時刻 `startedAt` に始めたセッションの計算に要る変更（ADR 0016）。
   * 始めた時刻に効いていた変更（始める前の最後の変更）と、それより後の変更。
   * セッションを閉じたあとの変更は計算に影響しない（終了したあとは状態が変わらない）が、
   * 応答を小さくするため、閉じたセッションでは呼び出し側が閉じた時刻までに絞る。
   */
  relevantSince: (
    changes: ReadonlyArray<AdvanceModeChange>,
    startedAt: Date,
  ): ReadonlyArray<AdvanceModeChange> => {
    const firstAfter = changes.findIndex((change) => change.at.getTime() > startedAt.getTime());
    const after = firstAfter === -1 ? changes.length : firstAfter;
    return changes.slice(Math.max(0, after - 1));
  },
} as const;

// ---------------------------------------------------------------------------
// ワークフローが使う読み書きの契約
// ---------------------------------------------------------------------------

/** 進め方の変更履歴を時刻の順に読む */
export type LoadAdvanceModeChanges = () => ReadonlyArray<AdvanceModeChange>;

/** 進め方の変更を記録する */
export type SaveAdvanceModeChange = (change: AdvanceModeChange) => void;
