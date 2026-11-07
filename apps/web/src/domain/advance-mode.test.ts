import { goldenCases } from "../testing/golden.ts";
import { AdvanceMode, AdvanceModeChange } from "./advance-mode.ts";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 17, 0, minutes, 0));
const manualFocusToJournal = { ...AdvanceMode.default, FocusToJournal: "Manual" } as const;

const changesWithManualBetween1And5 = [
  { at: at(1), mode: manualFocusToJournal },
  { at: at(5), mode: AdvanceMode.default },
];

goldenCases(
  "AdvanceModeChange.modeAt",
  (i: Readonly<{ changes: ReadonlyArray<AdvanceModeChange>; time: Date }>) =>
    AdvanceModeChange.modeAt(i.changes, i.time),
  [
    {
      name: "変えたことがなければ、すべての切り替わりが自動",
      input: { changes: [], time: at(0) },
      expected: {
        FocusToJournal: "Auto",
        JournalToFocus: "Auto",
        JournalToBreak: "Auto",
        BreakToFocus: "Auto",
      },
    },
    {
      name: "ある時刻に効いているのは、その時刻までの最後の変更（手動に変えたあと）",
      input: { changes: changesWithManualBetween1And5, time: at(3) },
      expected: manualFocusToJournal,
    },
    {
      name: "ある時刻に効いているのは、その時刻までの最後の変更（自動に戻したちょうどの時刻）",
      input: { changes: changesWithManualBetween1And5, time: at(5) },
      expected: AdvanceMode.default,
    },
  ],
);

goldenCases(
  "AdvanceMode.isManual",
  (
    i: Readonly<{
      mode: AdvanceMode;
      from: "Focus" | "Journal" | "Break";
      to: "Focus" | "Journal" | "Break";
    }>,
  ) => AdvanceMode.isManual(i.mode, i.from, i.to),
  [
    {
      name: "ジャーナルの終わりは、次が休憩かどうかで別の切り替わりとして選ぶ（次が休憩）",
      input: {
        mode: { ...AdvanceMode.default, JournalToBreak: "Manual" },
        from: "Journal",
        to: "Break",
      },
      expected: true,
    },
    {
      name: "ジャーナルの終わりは、次が休憩かどうかで別の切り替わりとして選ぶ（次が集中）",
      input: {
        mode: { ...AdvanceMode.default, JournalToBreak: "Manual" },
        from: "Journal",
        to: "Focus",
      },
      expected: false,
    },
  ],
);

const relevantChanges = [
  { at: at(1), mode: manualFocusToJournal },
  { at: at(2), mode: AdvanceMode.default },
  { at: at(10), mode: manualFocusToJournal },
];

goldenCases(
  "AdvanceModeChange.relevantSince",
  (i: Readonly<{ changes: ReadonlyArray<AdvanceModeChange>; startedAt: Date }>) =>
    AdvanceModeChange.relevantSince(i.changes, i.startedAt),
  [
    {
      name: "セッションの計算に要るのは、始めた時刻に効いていた変更とそれより後の変更",
      input: { changes: relevantChanges, startedAt: at(5) },
      expected: [
        { at: at(2), mode: AdvanceMode.default },
        { at: at(10), mode: manualFocusToJournal },
      ],
    },
    {
      name: "セッションの計算に要るのは、始めた時刻に効いていた変更とそれより後の変更（始める前に変更がなければすべて）",
      input: { changes: relevantChanges, startedAt: at(0) },
      expected: relevantChanges,
    },
    {
      name: "セッションの計算に要るのは、始めた時刻に効いていた変更とそれより後の変更（変更がなければ空）",
      input: { changes: [], startedAt: at(5) },
      expected: [],
    },
  ],
);
