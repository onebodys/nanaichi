import { describe, expect, test } from "vite-plus/test";
import { AdvanceMode, AdvanceModeChange } from "./advance-mode.ts";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 17, 0, minutes, 0));
const manualFocusToJournal = { ...AdvanceMode.default, FocusToJournal: "Manual" } as const;

describe("フェーズの進め方", () => {
  test("変えたことがなければ、すべての切り替わりが自動", () => {
    expect(AdvanceModeChange.modeAt([], at(0))).toEqual({
      FocusToJournal: "Auto",
      JournalToFocus: "Auto",
      JournalToBreak: "Auto",
      BreakToFocus: "Auto",
    });
  });

  test("ある時刻に効いているのは、その時刻までの最後の変更", () => {
    const changes = [
      { at: at(1), mode: manualFocusToJournal },
      { at: at(5), mode: AdvanceMode.default },
    ];

    expect(AdvanceModeChange.modeAt(changes, at(3))).toEqual(manualFocusToJournal);
    expect(AdvanceModeChange.modeAt(changes, at(5))).toEqual(AdvanceMode.default);
  });

  test("ジャーナルの終わりは、次が休憩かどうかで別の切り替わりとして選ぶ", () => {
    const mode = { ...AdvanceMode.default, JournalToBreak: "Manual" } as const;

    expect(AdvanceMode.isManual(mode, "Journal", "Break")).toBe(true);
    expect(AdvanceMode.isManual(mode, "Journal", "Focus")).toBe(false);
  });

  test("セッションの計算に要るのは、始めた時刻に効いていた変更とそれより後の変更", () => {
    const changes = [
      { at: at(1), mode: manualFocusToJournal },
      { at: at(2), mode: AdvanceMode.default },
      { at: at(10), mode: manualFocusToJournal },
    ];

    expect(AdvanceModeChange.relevantSince(changes, at(5))).toEqual(changes.slice(1));
    expect(AdvanceModeChange.relevantSince(changes, at(0))).toEqual(changes);
    expect(AdvanceModeChange.relevantSince([], at(5))).toEqual([]);
  });
});
