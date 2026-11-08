import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import { goldenCases, settled } from "../testing/golden.ts";
import { AdvanceMode, type AdvanceModeChange } from "./advance-mode.ts";
import type { SessionEvents, SessionOperation } from "./session-event.ts";
import {
  autoEndDueAt,
  deriveCompletedSetTimes,
  deriveSetOutcomes,
  deriveTimerState,
  type TimerState,
} from "./timer-state.ts";

// セッションを始めた時刻からの経過で時刻を書く（`at(7)` は開始から7分後、`at(3, 20)` は3分20秒後）
const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
const at = (minutes: number, seconds = 0) =>
  new Date(STARTED_AT + minutes * 60_000 + seconds * 1000);

const start = [{ kind: "Start", at: at(0) }] as const satisfies SessionEvents;

type DerivationInput = Readonly<{
  events: SessionEvents;
  now: Date;
  journalEntryTimes: ReadonlyArray<Date>;
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>;
}>;

const input = (
  events: SessionEvents,
  now: Date,
  journalEntryTimes: ReadonlyArray<Date> = [],
  advanceModeChanges: ReadonlyArray<AdvanceModeChange> = [],
): DerivationInput => ({ events, now, journalEntryTimes, advanceModeChanges });

const running = (endsAt: Date) => ({ kind: "Running", endsAt }) as const;
const paused = (pausedAt: Date) => ({ kind: "Paused", pausedAt }) as const;

const runDeriveTimerState = (i: DerivationInput) =>
  settled(deriveTimerState(i.events, i.now, i.journalEntryTimes, i.advanceModeChanges));
type Derived = ReturnType<typeof runDeriveTimerState>;

const success = (value: TimerState): Derived => ({ kind: "Success", value });
const rejected = (
  operation: SessionOperation["kind"],
  rejectedAt: Date,
  during: TimerState["kind"],
): Derived => ({
  kind: "Failure",
  error: { kind: "OperationRejected", operation, at: rejectedAt, during },
});

/** 開始より前（`at(-1)`）に、`overrides` の切り替わりだけを手動にしておく */
const manualFrom = (
  overrides: Partial<AdvanceMode>,
  changedAt: Date = at(-1),
): AdvanceModeChange => ({ at: changedAt, mode: { ...AdvanceMode.default, ...overrides } });
const focusToJournal = [manualFrom({ FocusToJournal: "Manual" })];

goldenCases("deriveTimerState", runDeriveTimerState, [
  // フェーズの自動的な切り替わり
  {
    name: "開始すると1ラウンド目の1セット目の集中が7分で始まる",
    input: input(start, at(0)),
    expected: success({
      kind: "Focus",
      round: 1,
      setNumber: 1,
      completedSets: 0,
      remainingSeconds: 7 * 60,
      clock: running(at(7)),
    }),
  },
  {
    name: "集中の残り秒数と次の切り替わり時刻がわかる",
    input: input(start, at(3, 20)),
    expected: success({
      kind: "Focus",
      round: 1,
      setNumber: 1,
      completedSets: 0,
      remainingSeconds: 3 * 60 + 40,
      clock: running(at(7)),
    }),
  },
  {
    name: "残り秒数は1秒未満の端数を切り上げる",
    input: input(start, new Date(at(6, 59).getTime() + 1)),
    expected: success({
      kind: "Focus",
      round: 1,
      setNumber: 1,
      completedSets: 0,
      remainingSeconds: 1,
      clock: running(at(7)),
    }),
  },
  {
    name: "集中を最後まで終えるとジャーナルに切り替わり、完了セットになる",
    input: input(start, at(7)),
    expected: success({
      kind: "Journal",
      round: 1,
      setNumber: 1,
      completedSets: 1,
      remainingSeconds: 60,
      clock: running(at(8)),
    }),
  },
  {
    name: "ジャーナルが終わると次のセットの集中が始まる",
    input: input(start, at(8)),
    expected: success({
      kind: "Focus",
      round: 1,
      setNumber: 2,
      completedSets: 1,
      remainingSeconds: 7 * 60,
      clock: running(at(15)),
    }),
  },
  {
    name: "3セット目のジャーナルが終わると休憩が5分入る（終わる前はジャーナルのまま）",
    input: input(start, at(23, 30)),
    expected: success({
      kind: "Journal",
      round: 1,
      setNumber: 3,
      completedSets: 3,
      remainingSeconds: 30,
      clock: running(at(24)),
    }),
  },
  {
    name: "3セット目のジャーナルが終わると休憩が5分入る",
    input: input(start, at(24)),
    expected: success({
      kind: "Break",
      round: 1,
      completedSets: 3,
      remainingSeconds: 5 * 60,
      clock: running(at(29)),
    }),
  },
  {
    name: "休憩が終わると次のラウンドの1セット目の集中が始まる",
    input: input(start, at(29)),
    expected: success({
      kind: "Focus",
      round: 2,
      setNumber: 1,
      completedSets: 3,
      remainingSeconds: 7 * 60,
      clock: running(at(36)),
    }),
  },

  // 一時停止
  {
    name: "集中中に一時停止すると残り時間が止まり、次の切り替わり時刻を持たない",
    input: input([...start, { kind: "Pause", at: at(3) }], at(20)),
    expected: success({
      kind: "Focus",
      round: 1,
      setNumber: 1,
      completedSets: 0,
      remainingSeconds: 4 * 60,
      clock: paused(at(3)),
    }),
  },
  {
    name: "再開すると止めたところから進み、切り替わり時刻が一時停止した分だけ後ろにずれる",
    input: input([...start, { kind: "Pause", at: at(3) }, { kind: "Resume", at: at(10) }], at(10)),
    expected: success({
      kind: "Focus",
      round: 1,
      setNumber: 1,
      completedSets: 0,
      remainingSeconds: 4 * 60,
      clock: running(at(14)),
    }),
  },
  {
    name: "再開すると止めたところから進み、一時停止した分だけ後ろにずれた時刻でジャーナルに移る",
    input: input([...start, { kind: "Pause", at: at(3) }, { kind: "Resume", at: at(10) }], at(14)),
    expected: success({
      kind: "Journal",
      round: 1,
      setNumber: 1,
      completedSets: 1,
      remainingSeconds: 60,
      clock: running(at(15)),
    }),
  },
  {
    name: "一時停止しても完了セットかどうかに影響しない",
    input: input([...start, { kind: "Pause", at: at(3) }, { kind: "Resume", at: at(10) }], at(14)),
    expected: success({
      kind: "Journal",
      round: 1,
      setNumber: 1,
      completedSets: 1,
      remainingSeconds: 60,
      clock: running(at(15)),
    }),
  },
  {
    name: "ジャーナル中も一時停止できる",
    input: input([...start, { kind: "Pause", at: at(7, 30) }], at(30)),
    expected: success({
      kind: "Journal",
      round: 1,
      setNumber: 1,
      completedSets: 1,
      remainingSeconds: 30,
      clock: paused(at(7, 30)),
    }),
  },
  {
    name: "休憩中も一時停止でき、再開すると休憩の続きから進む（再開前は止まったまま）",
    input: input([...start, { kind: "Pause", at: at(25) }, { kind: "Resume", at: at(40) }], at(39)),
    expected: success({
      kind: "Break",
      round: 1,
      completedSets: 3,
      remainingSeconds: 4 * 60,
      clock: paused(at(25)),
    }),
  },
  {
    name: "休憩中も一時停止でき、再開すると休憩の続きから進む",
    input: input([...start, { kind: "Pause", at: at(25) }, { kind: "Resume", at: at(40) }], at(44)),
    expected: success({
      kind: "Focus",
      round: 2,
      setNumber: 1,
      completedSets: 3,
      remainingSeconds: 7 * 60,
      clock: running(at(51)),
    }),
  },
  {
    name: "待機中は一時停止できない",
    input: input([...start, { kind: "Abort", at: at(3) }, { kind: "Pause", at: at(4) }], at(5)),
    expected: rejected("Pause", at(4), "Idle"),
  },
  {
    name: "一時停止していなければ再開できない",
    input: input([...start, { kind: "Resume", at: at(3) }], at(5)),
    expected: rejected("Resume", at(3), "Focus"),
  },

  // 中断
  {
    name: "集中中に中断すると不成立セットになり待機に戻る",
    input: input([...start, { kind: "Abort", at: at(3) }], at(30)),
    expected: success({ kind: "Idle", round: 1, setNumber: 1, completedSets: 0 }),
  },
  {
    // 1セット目は完了し、2セット目の集中を3分目に中断した
    name: "中断した後の集中の再開始は、同じセット番号でやり直しになる",
    input: input(
      [...start, { kind: "Abort", at: at(10) }, { kind: "RestartFocus", at: at(12) }],
      at(12),
    ),
    expected: success({
      kind: "Focus",
      round: 1,
      setNumber: 2,
      completedSets: 1,
      remainingSeconds: 7 * 60,
      clock: running(at(19)),
    }),
  },
  {
    // やり直した1セット目から3セット終えるのは 5 + 24 = 29分
    name: "不成立セットはラウンド内のセット数に数えないので、休憩までのセットが1つ増える（3セット目のジャーナル）",
    input: input(
      [...start, { kind: "Abort", at: at(3) }, { kind: "RestartFocus", at: at(5) }],
      at(28),
    ),
    expected: success({
      kind: "Journal",
      round: 1,
      setNumber: 3,
      completedSets: 3,
      remainingSeconds: 60,
      clock: running(at(29)),
    }),
  },
  {
    name: "不成立セットはラウンド内のセット数に数えないので、休憩までのセットが1つ増える",
    input: input(
      [...start, { kind: "Abort", at: at(3) }, { kind: "RestartFocus", at: at(5) }],
      at(29),
    ),
    expected: success({
      kind: "Break",
      round: 1,
      completedSets: 3,
      remainingSeconds: 5 * 60,
      clock: running(at(34)),
    }),
  },
  {
    name: "一時停止中の集中も中断できる",
    input: input([...start, { kind: "Pause", at: at(3) }, { kind: "Abort", at: at(4) }], at(5)),
    expected: success({ kind: "Idle", round: 1, setNumber: 1, completedSets: 0 }),
  },
  {
    name: "ジャーナル中は中断できない",
    input: input([...start, { kind: "Abort", at: at(7, 30) }], at(8)),
    expected: rejected("Abort", at(7, 30), "Journal"),
  },
  {
    name: "休憩中は中断できない",
    input: input([...start, { kind: "Abort", at: at(25) }], at(26)),
    expected: rejected("Abort", at(25), "Break"),
  },
  {
    name: "待機中でなければ集中の再開始はできない",
    input: input([...start, { kind: "RestartFocus", at: at(3) }], at(4)),
    expected: rejected("RestartFocus", at(3), "Focus"),
  },

  // 終了
  {
    name: "集中中に終了したセットは不成立セットになる",
    input: input([...start, { kind: "End", at: at(10) }], at(30)),
    expected: success({ kind: "Ended", endedAt: at(10), endedBy: "End", completedSets: 1 }),
  },
  {
    name: "ジャーナル中に終了したセットは完了セットのまま",
    input: input([...start, { kind: "End", at: at(7, 30) }], at(30)),
    expected: success({ kind: "Ended", endedAt: at(7, 30), endedBy: "End", completedSets: 1 }),
  },
  {
    name: "休憩中に終了しても完了セットのまま",
    input: input([...start, { kind: "End", at: at(26) }], at(30)),
    expected: success({ kind: "Ended", endedAt: at(26), endedBy: "End", completedSets: 3 }),
  },
  {
    name: "一時停止中の集中で終了したセットも不成立セットになる",
    input: input([...start, { kind: "Pause", at: at(3) }, { kind: "End", at: at(20) }], at(30)),
    expected: success({ kind: "Ended", endedAt: at(20), endedBy: "End", completedSets: 0 }),
  },
  {
    name: "待機中も終了できる",
    input: input([...start, { kind: "Abort", at: at(3) }, { kind: "End", at: at(4) }], at(5)),
    expected: success({ kind: "Ended", endedAt: at(4), endedBy: "End", completedSets: 0 }),
  },
  {
    name: "終了した後は操作できない",
    input: input(
      [...start, { kind: "End", at: at(3) }, { kind: "RestartFocus", at: at(4) }],
      at(5),
    ),
    expected: rejected("RestartFocus", at(4), "Ended"),
  },

  // 休憩スキップ
  {
    name: "休憩スキップで次のラウンドの集中がすぐ始まる",
    input: input([...start, { kind: "SkipBreak", at: at(25) }], at(25)),
    expected: success({
      kind: "Focus",
      round: 2,
      setNumber: 1,
      completedSets: 3,
      remainingSeconds: 7 * 60,
      clock: running(at(32)),
    }),
  },
  {
    name: "一時停止中の休憩もスキップできる",
    input: input(
      [...start, { kind: "Pause", at: at(25) }, { kind: "SkipBreak", at: at(40) }],
      at(40),
    ),
    expected: success({
      kind: "Focus",
      round: 2,
      setNumber: 1,
      completedSets: 3,
      remainingSeconds: 7 * 60,
      clock: running(at(47)),
    }),
  },
  {
    name: "休憩中でなければスキップできない",
    input: input([...start, { kind: "SkipBreak", at: at(3) }], at(4)),
    expected: rejected("SkipBreak", at(3), "Focus"),
  },

  // 自動終了
  {
    name: "記入も操作もないまま2ラウンド分（58分）過ぎると、最後の操作の時刻で閉じ、それ以降のセットは数えない",
    input: input(start, at(58)),
    expected: success({ kind: "Ended", endedAt: at(0), endedBy: "AutoEnd", completedSets: 0 }),
  },
  {
    name: "2ラウンド分に満たなければ自動終了しない",
    input: input(start, new Date(at(58).getTime() - 1)),
    expected: success({
      kind: "Break",
      round: 2,
      completedSets: 6,
      remainingSeconds: 1,
      clock: running(at(58)),
    }),
  },
  {
    name: "ジャーナル記入があれば、最後の記入の時刻で閉じ、そこまでの完了セットを数える（閉じる前）",
    input: input(start, at(73), [at(7, 30), at(15, 30)]),
    expected: success({
      kind: "Journal",
      round: 3,
      setNumber: 2,
      completedSets: 8,
      remainingSeconds: 60,
      clock: running(at(74)),
    }),
  },
  {
    name: "ジャーナル記入があれば、最後の記入の時刻で閉じ、そこまでの完了セットを数える",
    input: input(start, at(73, 30), [at(7, 30), at(15, 30)]),
    expected: success({ kind: "Ended", endedAt: at(15, 30), endedBy: "AutoEnd", completedSets: 2 }),
  },
  {
    name: "最後の操作が集中の途中なら、そのセットは不成立セットになる",
    input: input([...start, { kind: "Pause", at: at(10) }], at(68)),
    expected: success({ kind: "Ended", endedAt: at(10), endedBy: "AutoEnd", completedSets: 1 }),
  },
  {
    name: "一時停止したまま2ラウンド分過ぎても自動終了する",
    input: input([...start, { kind: "Pause", at: at(7, 30) }], at(65, 30)),
    expected: success({ kind: "Ended", endedAt: at(7, 30), endedBy: "AutoEnd", completedSets: 1 }),
  },
  {
    name: "待機のまま2ラウンド分過ぎても自動終了する",
    input: input([...start, { kind: "Abort", at: at(3) }], at(61)),
    expected: success({ kind: "Ended", endedAt: at(3), endedBy: "AutoEnd", completedSets: 0 }),
  },
  {
    name: "自動終了した時刻より後の操作は受け付けない",
    input: input([...start, { kind: "Pause", at: at(60) }], at(61)),
    expected: rejected("Pause", at(60), "Ended"),
  },
  {
    name: "手動で終了したセッションは自動終了に書き換わらない",
    input: input([...start, { kind: "End", at: at(10) }], at(200)),
    expected: success({ kind: "Ended", endedAt: at(10), endedBy: "End", completedSets: 1 }),
  },

  // 操作イベントの並び
  {
    name: "指定した時刻より後の操作イベントはまだ起きていないものとして扱う",
    input: input([...start, { kind: "Pause", at: at(5) }], at(4)),
    expected: success({
      kind: "Focus",
      round: 1,
      setNumber: 1,
      completedSets: 0,
      remainingSeconds: 3 * 60,
      clock: running(at(7)),
    }),
  },
  {
    name: "操作イベントが時刻の順に並んでいなければ失敗する",
    input: input([...start, { kind: "Pause", at: at(5) }, { kind: "Resume", at: at(4) }], at(6)),
    expected: { kind: "Failure", error: { kind: "EventOutOfOrder", at: at(4) } },
  },

  // フェーズの進め方が手動の切り替わり
  {
    name: "集中 → ジャーナルが手動なら、集中の時間が過ぎると 0:00 の切り替え待ちで止まる",
    input: input(start, at(10), [], focusToJournal),
    expected: success({
      kind: "AwaitingAdvance",
      finished: { kind: "Focus", round: 1, setNumber: 1 },
      completedSets: 1,
      since: at(7),
    }),
  },
  {
    name: "切り替え待ちで進めると、押した時刻から次のフェーズが始まる",
    input: input([...start, { kind: "Advance", at: at(9) }], at(9, 30), [], focusToJournal),
    expected: success({
      kind: "Journal",
      round: 1,
      setNumber: 1,
      completedSets: 1,
      remainingSeconds: 30,
      clock: running(at(10)),
    }),
  },
  {
    // ジャーナルの後は自動なので、次のセットの集中に進む
    name: "切り替え待ちで進めると、ジャーナルのあとは自動で次のセットの集中に進む",
    input: input([...start, { kind: "Advance", at: at(9) }], at(11), [], focusToJournal),
    expected: success({
      kind: "Focus",
      round: 1,
      setNumber: 2,
      completedSets: 1,
      remainingSeconds: 6 * 60,
      clock: running(at(17)),
    }),
  },
  {
    name: "ジャーナル → 集中だけを手動にすると、集中 → ジャーナルは自動のまま進む",
    input: input(start, at(7, 30), [], [manualFrom({ JournalToFocus: "Manual" })]),
    expected: success({
      kind: "Journal",
      round: 1,
      setNumber: 1,
      completedSets: 1,
      remainingSeconds: 30,
      clock: running(at(8)),
    }),
  },
  {
    name: "ジャーナル → 集中だけを手動にすると、ジャーナルの終わりが切り替え待ちになる",
    input: input(start, at(12), [], [manualFrom({ JournalToFocus: "Manual" })]),
    expected: success({
      kind: "AwaitingAdvance",
      finished: { kind: "Journal", round: 1, setNumber: 1 },
      completedSets: 1,
      since: at(8),
    }),
  },
  {
    name: "ジャーナル → 休憩が手動なら、休憩に入る前の切り替え待ちになる",
    input: input(start, at(26), [], [manualFrom({ JournalToBreak: "Manual" })]),
    expected: success({
      kind: "AwaitingAdvance",
      finished: { kind: "Journal", round: 1, setNumber: 3 },
      completedSets: 3,
      since: at(24),
    }),
  },
  {
    name: "ジャーナル → 休憩が手動なら、休憩に入る前の切り替え待ちから休憩をスキップして次のラウンドに進める",
    input: input(
      [...start, { kind: "SkipBreak", at: at(30) }],
      at(30),
      [],
      [manualFrom({ JournalToBreak: "Manual" })],
    ),
    expected: success({
      kind: "Focus",
      round: 2,
      setNumber: 1,
      completedSets: 3,
      remainingSeconds: 7 * 60,
      clock: running(at(37)),
    }),
  },
  {
    name: "休憩 → 集中が手動なら、休憩が終わると次のラウンドの前で待つ",
    input: input(start, at(40), [], [manualFrom({ BreakToFocus: "Manual" })]),
    expected: success({
      kind: "AwaitingAdvance",
      finished: { kind: "Break", round: 1 },
      completedSets: 3,
      since: at(29),
    }),
  },
  {
    name: "切り替え待ちでは一時停止はできない",
    input: input([...start, { kind: "Pause", at: at(8) }], at(8), [], focusToJournal),
    expected: rejected("Pause", at(8), "AwaitingAdvance"),
  },
  {
    name: "切り替え待ちでは中断はできない",
    input: input([...start, { kind: "Abort", at: at(8) }], at(8), [], focusToJournal),
    expected: rejected("Abort", at(8), "AwaitingAdvance"),
  },
  {
    name: "切り替え待ちでは集中の再開始はできない",
    input: input([...start, { kind: "RestartFocus", at: at(8) }], at(8), [], focusToJournal),
    expected: rejected("RestartFocus", at(8), "AwaitingAdvance"),
  },
  {
    name: "休憩に入る前でない切り替え待ちでは、休憩をスキップできない",
    input: input([...start, { kind: "SkipBreak", at: at(8) }], at(8), [], focusToJournal),
    expected: rejected("SkipBreak", at(8), "AwaitingAdvance"),
  },
  {
    name: "進めるのは切り替え待ちでしかできない",
    input: input([...start, { kind: "Advance", at: at(3) }], at(3)),
    expected: rejected("Advance", at(3), "Focus"),
  },
  {
    name: "セッションの途中で手動に変えると、そのとき進めているフェーズの終わりから効く（変える前の集中）",
    input: input(start, at(2), [], [manualFrom({ FocusToJournal: "Manual" }, at(3))]),
    expected: success({
      kind: "Focus",
      round: 1,
      setNumber: 1,
      completedSets: 0,
      remainingSeconds: 5 * 60,
      clock: running(at(7)),
    }),
  },
  {
    name: "セッションの途中で手動に変えると、そのとき進めているフェーズの終わりから効く",
    input: input(start, at(8), [], [manualFrom({ FocusToJournal: "Manual" }, at(3))]),
    expected: success({
      kind: "AwaitingAdvance",
      finished: { kind: "Focus", round: 1, setNumber: 1 },
      completedSets: 1,
      since: at(7),
    }),
  },
  {
    name: "待っている切り替わりを自動に変えると、変えた時刻から次のフェーズが始まる",
    input: input(
      start,
      at(9, 15),
      [],
      [...focusToJournal, { at: at(9), mode: AdvanceMode.default }],
    ),
    expected: success({
      kind: "Journal",
      round: 1,
      setNumber: 1,
      completedSets: 1,
      remainingSeconds: 45,
      clock: running(at(10)),
    }),
  },
  {
    // 開始より前に2回変えている。効くのは開始の時点で最後のもの
    name: "始める前に変えた進め方でセッションを計算し、その後の変更はその時刻から効く",
    input: input(
      start,
      at(7, 30),
      [],
      [manualFrom({ FocusToJournal: "Manual" }, at(-5)), { at: at(-2), mode: AdvanceMode.default }],
    ),
    expected: success({
      kind: "Journal",
      round: 1,
      setNumber: 1,
      completedSets: 1,
      remainingSeconds: 30,
      clock: running(at(8)),
    }),
  },
  {
    name: "切り替え待ちのまま記入も操作もなく2ラウンド分過ぎると、最後の操作の時刻で自動終了する",
    input: input(start, at(58), [], focusToJournal),
    expected: success({ kind: "Ended", endedAt: at(0), endedBy: "AutoEnd", completedSets: 0 }),
  },
  {
    // 進め方を変えた 30分の時点を操作として数えるので、自動終了は 30 + 58 = 88分。
    // 60分はまだ終了しておらず、30分以降に始まった2ラウンド目の1セット目の集中（29〜36分）の終わりで待っている
    name: "セッション中に進め方を変えると、操作として自動終了までの時間が延びる",
    input: input(start, at(60), [], [manualFrom({ FocusToJournal: "Manual" }, at(30))]),
    expected: success({
      kind: "AwaitingAdvance",
      finished: { kind: "Focus", round: 2, setNumber: 1 },
      completedSets: 4,
      since: at(36),
    }),
  },
]);

goldenCases(
  "deriveCompletedSetTimes",
  (i: DerivationInput) =>
    settled(deriveCompletedSetTimes(i.events, i.now, i.journalEntryTimes, i.advanceModeChanges)),
  [
    {
      name: "完了セットは集中を最後まで終えた時刻に数え、ジャーナルの終わりではない",
      input: input(start, at(16)),
      expected: { kind: "Success", value: [at(7), at(15)] },
    },
    {
      name: "一時停止した分だけ、集中を終えた時刻が後ろにずれる",
      input: input([...start, { kind: "Pause", at: at(2) }, { kind: "Resume", at: at(5) }], at(11)),
      expected: { kind: "Success", value: [at(10)] },
    },
    {
      name: "中断した不成立セットは数えない",
      input: input([...start, { kind: "Abort", at: at(3) }], at(20)),
      expected: { kind: "Success", value: [] },
    },
    {
      name: "自動終了したら、最後の操作より後に終わるはずだったセットは数えない",
      input: input(start, at(120)),
      expected: { kind: "Success", value: [] },
    },
    {
      // 1セット目は 7分に終え、2分待ってからジャーナル（9〜10分）、2セット目の集中は 10〜17分
      name: "待っている時間は完了セットの集中に数えず、後のセットはその分だけ後ろにずれる",
      input: input([...start, { kind: "Advance", at: at(9) }], at(20), [], focusToJournal),
      expected: { kind: "Success", value: [at(7), at(17)] },
    },
  ],
);

goldenCases(
  "deriveSetOutcomes",
  (i: DerivationInput) =>
    settled(deriveSetOutcomes(i.events, i.now, i.journalEntryTimes, i.advanceModeChanges)),
  [
    {
      name: "集中を最後まで終えたセットは、集中を終えた時刻の完了セットになる",
      input: input(start, at(16)),
      expected: {
        kind: "Success",
        value: [
          { kind: "CompletedSet", round: 1, setNumber: 1, at: at(7) },
          { kind: "CompletedSet", round: 1, setNumber: 2, at: at(15) },
        ],
      },
    },
    {
      name: "集中中に中断すると不成立セットになり、集中を再開始すると同じセット番号でやり直す",
      input: input(
        [...start, { kind: "Abort", at: at(3) }, { kind: "RestartFocus", at: at(5) }],
        at(13),
      ),
      expected: {
        kind: "Success",
        value: [
          { kind: "AbortedSet", round: 1, setNumber: 1, at: at(3) },
          { kind: "CompletedSet", round: 1, setNumber: 1, at: at(12) },
        ],
      },
    },
    {
      name: "一時停止中の集中を中断しても不成立セットになる",
      input: input([...start, { kind: "Pause", at: at(2) }, { kind: "Abort", at: at(4) }], at(5)),
      expected: {
        kind: "Success",
        value: [{ kind: "AbortedSet", round: 1, setNumber: 1, at: at(4) }],
      },
    },
    {
      name: "集中の途中で終了したセットは不成立セットになる",
      input: input([...start, { kind: "End", at: at(10) }], at(11)),
      expected: {
        kind: "Success",
        value: [
          { kind: "CompletedSet", round: 1, setNumber: 1, at: at(7) },
          { kind: "AbortedSet", round: 1, setNumber: 2, at: at(10) },
        ],
      },
    },
    {
      name: "ジャーナル中に終了しても、不成立セットは増えない",
      input: input([...start, { kind: "End", at: at(7, 30) }], at(8)),
      expected: {
        kind: "Success",
        value: [{ kind: "CompletedSet", round: 1, setNumber: 1, at: at(7) }],
      },
    },
    {
      name: "待機中に終了しても、不成立セットは増えない",
      input: input([...start, { kind: "Abort", at: at(3) }, { kind: "End", at: at(4) }], at(5)),
      expected: {
        kind: "Success",
        value: [{ kind: "AbortedSet", round: 1, setNumber: 1, at: at(3) }],
      },
    },
    {
      // 最後の操作（開始）の時刻で閉じるので、1セット目の集中の途中で終了したのと同じ
      name: "自動終了した時刻が集中の途中なら、そのセットは不成立セットになる",
      input: input(start, at(120)),
      expected: {
        kind: "Success",
        value: [{ kind: "AbortedSet", round: 1, setNumber: 1, at: at(0) }],
      },
    },
    {
      name: "集中のあとの切り替え待ちで終了しても、そのセットは完了セットのまま",
      input: input([...start, { kind: "End", at: at(9) }], at(9), [], focusToJournal),
      expected: {
        kind: "Success",
        value: [{ kind: "CompletedSet", round: 1, setNumber: 1, at: at(7) }],
      },
    },
  ],
);

goldenCases(
  "autoEndDueAt",
  (i: Omit<DerivationInput, "now">) =>
    autoEndDueAt(i.events, i.journalEntryTimes, i.advanceModeChanges),
  [
    {
      name: "セッション中に進め方を変えると、操作として自動終了までの時間が延びる",
      input: {
        events: start,
        journalEntryTimes: [],
        advanceModeChanges: [manualFrom({ FocusToJournal: "Manual" }, at(30))],
      },
      expected: at(30 + 58),
    },
  ],
);

describe("計算の整合", () => {
  const derivedOf = (events: SessionEvents, now: Date) => {
    const derived = deriveTimerState(events, now, [], []);
    if (Result.isFailure(derived)) {
      throw new Error(`状態を計算できなかった: ${derived.error.kind}`);
    }
    return derived.value;
  };

  test("完了セットになった時刻の数はタイマーの状態の完了セット数と一致する", () => {
    const events = [
      ...start,
      { kind: "Pause", at: at(20) },
      { kind: "Resume", at: at(21) },
    ] as const satisfies SessionEvents;
    const times = deriveCompletedSetTimes(events, at(40), [], []);

    expect(Result.isSuccess(times) && times.value).toHaveLength(
      derivedOf(events, at(40)).completedSets,
    );
  });

  test("セットの結末の完了セットの数はタイマーの状態の完了セット数と一致する", () => {
    const events = [
      ...start,
      { kind: "Abort", at: at(10) },
      { kind: "RestartFocus", at: at(11) },
    ] as const satisfies SessionEvents;
    const outcomes = deriveSetOutcomes(events, at(40), [], []);

    expect(
      Result.isSuccess(outcomes) && outcomes.value.filter((set) => set.kind === "CompletedSet"),
    ).toHaveLength(derivedOf(events, at(40)).completedSets);
  });
});
