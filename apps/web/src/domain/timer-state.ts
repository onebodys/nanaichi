import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { AdvanceMode, AdvanceModeChange } from "./advance-mode.ts";
import { JsonDateSchema } from "./json-date.ts";
import type { SessionEvents, SessionOperation } from "./session-event.ts";

// MVP では時間とセット数のカスタム設定を作らないので固定する（docs/PRODUCT.md「タイマー」）。
const MINUTE_MS = 60_000;
const FOCUS_MS = 7 * MINUTE_MS;
const JOURNAL_MS = 1 * MINUTE_MS;
const BREAK_MS = 5 * MINUTE_MS;
/** 休憩までのセット数（GLOSSARY の「ラウンド」） */
export const SETS_PER_ROUND = 3;
const ROUND_MS = SETS_PER_ROUND * (FOCUS_MS + JOURNAL_MS) + BREAK_MS;
/** 自動終了までの、ジャーナル記入も操作もない時間（2ラウンド分 = 58分） */
const AUTO_END_AFTER_MS = 2 * ROUND_MS;

// ---------------------------------------------------------------------------
// ある時刻のタイマーの状態（deriveTimerState の返り値）
// ---------------------------------------------------------------------------

/** フェーズの時計。一時停止中は進まないので、次の切り替わり時刻を持たない */
type Clock =
  | Readonly<{ kind: "Running"; endsAt: Date }>
  | Readonly<{ kind: "Paused"; pausedAt: Date }>;

type Idle = Readonly<{
  kind: "Idle";
  round: number;
  setNumber: number;
  completedSets: number;
}>;

type Focus = Readonly<{
  kind: "Focus";
  round: number;
  setNumber: number;
  completedSets: number;
  remainingSeconds: number;
  clock: Clock;
}>;

type Journal = Readonly<{
  kind: "Journal";
  round: number;
  setNumber: number;
  completedSets: number;
  remainingSeconds: number;
  clock: Clock;
}>;

/** 休憩はどのセットにも属さないので、セット番号を持たない */
type Break = Readonly<{
  kind: "Break";
  round: number;
  completedSets: number;
  remainingSeconds: number;
  clock: Clock;
}>;

/**
 * 切り替え待ち（GLOSSARY）。フェーズの進め方が手動の切り替わりで、`finished` のフェーズの時間が過ぎ、
 * 人が進めるまで次のフェーズを始めずに待っている。残り時間は 0:00 のまま止まる。
 *
 * - `finished`: 時間が過ぎて終わったフェーズ。進めると `nextPhase(finished)` が始まる
 * - `since`: 終わった時刻（待ち始めた時刻）
 */
type AwaitingAdvance = Readonly<{
  kind: "AwaitingAdvance";
  finished: Phase;
  completedSets: number;
  since: Date;
}>;

export type Ended = Readonly<{
  kind: "Ended";
  endedAt: Date;
  endedBy: "End" | "AutoEnd";
  completedSets: number;
}>;

export type TimerState = Idle | Focus | Journal | Break | AwaitingAdvance | Ended;

// ---------------------------------------------------------------------------
// JSON にしたタイマーの状態（API の応答）を検証して TimerState に戻す（AGENTS.md §5）
// ---------------------------------------------------------------------------

const positiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));
const nonNegativeInt = v.pipe(v.number(), v.integer(), v.minValue(0));

const ClockJsonSchema = v.variant("kind", [
  v.object({ kind: v.literal("Running"), endsAt: JsonDateSchema }),
  v.object({ kind: v.literal("Paused"), pausedAt: JsonDateSchema }),
]);

const setPhaseJsonSchema = <K extends "Focus" | "Journal">(kind: K) =>
  v.object({
    kind: v.literal(kind),
    round: positiveInt,
    setNumber: positiveInt,
    completedSets: nonNegativeInt,
    remainingSeconds: nonNegativeInt,
    clock: ClockJsonSchema,
  });

const PhaseJsonSchema = v.variant("kind", [
  v.object({ kind: v.literal("Focus"), round: positiveInt, setNumber: positiveInt }),
  v.object({ kind: v.literal("Journal"), round: positiveInt, setNumber: positiveInt }),
  v.object({ kind: v.literal("Break"), round: positiveInt }),
]);

export const TimerStateJsonSchema: v.GenericSchema<unknown, TimerState> = v.variant("kind", [
  v.object({
    kind: v.literal("Idle"),
    round: positiveInt,
    setNumber: positiveInt,
    completedSets: nonNegativeInt,
  }),
  setPhaseJsonSchema("Focus"),
  setPhaseJsonSchema("Journal"),
  v.object({
    kind: v.literal("Break"),
    round: positiveInt,
    completedSets: nonNegativeInt,
    remainingSeconds: nonNegativeInt,
    clock: ClockJsonSchema,
  }),
  v.object({
    kind: v.literal("AwaitingAdvance"),
    finished: PhaseJsonSchema,
    completedSets: nonNegativeInt,
    since: JsonDateSchema,
  }),
  v.object({
    kind: v.literal("Ended"),
    endedAt: JsonDateSchema,
    endedBy: v.picklist(["End", "AutoEnd"]),
    completedSets: nonNegativeInt,
  }),
]);

/** その状態ではできない操作（休憩中の中断、待機中の一時停止、終了後の操作など） */
export type OperationRejected = Readonly<{
  kind: "OperationRejected";
  operation: SessionOperation["kind"];
  at: Date;
  during: TimerState["kind"];
}>;

type DeriveTimerStateError =
  | OperationRejected
  /** 操作イベントが時刻の順に並んでいない */
  | Readonly<{ kind: "EventOutOfOrder"; at: Date }>;

// ---------------------------------------------------------------------------
// 計算の途中で持つ状態。時刻はミリ秒で扱い、返すときに Date にする
// ---------------------------------------------------------------------------

/** フェーズ（GLOSSARY）。集中・ジャーナルはセットに、休憩はラウンドに属する */
export type Phase =
  | Readonly<{ kind: "Focus"; round: number; setNumber: number }>
  | Readonly<{ kind: "Journal"; round: number; setNumber: number }>
  | Readonly<{ kind: "Break"; round: number }>;

/**
 * 1つのセットの結末（GLOSSARY の「完了セット」「不成立セット」）。`at` は集中を終えた時刻か、
 * 中断・終了した時刻。セッションの中の時刻の順に並べ、セッションのまとめでセットの並びとして出す。
 */
export type SetOutcome =
  | Readonly<{ kind: "CompletedSet"; round: number; setNumber: number; at: Date }>
  | Readonly<{ kind: "AbortedSet"; round: number; setNumber: number; at: Date }>;

/** 計算の途中で持つセットの結末。時刻はミリ秒 */
type SetRecord = Readonly<{
  kind: SetOutcome["kind"];
  round: number;
  setNumber: number;
  at: number;
}>;

type Progress =
  | Readonly<{
      kind: "Idle";
      round: number;
      setNumber: number;
      sets: ReadonlyArray<SetRecord>;
    }>
  /** `phaseStartedAt` は一時停止していた時間の分だけ後ろにずらした、見かけのフェーズ開始時刻 */
  | Readonly<{
      kind: "Running";
      phase: Phase;
      sets: ReadonlyArray<SetRecord>;
      phaseStartedAt: number;
    }>
  | Readonly<{
      kind: "Paused";
      phase: Phase;
      sets: ReadonlyArray<SetRecord>;
      elapsedMs: number;
      pausedAt: number;
    }>
  /** `since` はフェーズの時間が過ぎて切り替え待ちになった時刻 */
  | Readonly<{
      kind: "Awaiting";
      finished: Phase;
      sets: ReadonlyArray<SetRecord>;
      since: number;
    }>
  | Readonly<{
      kind: "Ended";
      endedAt: number;
      endedBy: "End" | "AutoEnd";
      sets: ReadonlyArray<SetRecord>;
    }>;

/** `mode` はいま効いているフェーズの進め方（ADR 0015） */
type Derivation = Readonly<{ progress: Progress; lastActivityAt: number; mode: AdvanceMode }>;

/**
 * 時刻の順に処理するもの。ジャーナル記入は状態を変えないが、自動終了までの時間を延ばす。
 * フェーズの進め方の変更は、待っている切り替わりを自動にすれば次のフェーズを始め、操作として自動終了までの時間も延ばす
 */
type Activity =
  | Readonly<{ kind: "Operation"; operation: SessionOperation }>
  | Readonly<{ kind: "JournalEntry"; at: Date }>
  | Readonly<{ kind: "AdvanceModeChanged"; change: AdvanceModeChange }>;

/** フェーズの長さ（ミリ秒） */
export const phaseDurationMsOf = (phase: Phase): number => {
  switch (phase.kind) {
    case "Focus":
      return FOCUS_MS;
    case "Journal":
      return JOURNAL_MS;
    case "Break":
      return BREAK_MS;
  }
};

/** フェーズの自動的な切り替わり: 集中 → ジャーナル → … 3セット後に休憩 → 次のラウンドの集中 */
export const nextPhase = (phase: Phase): Phase => {
  switch (phase.kind) {
    case "Focus":
      return { kind: "Journal", round: phase.round, setNumber: phase.setNumber };
    case "Journal":
      return phase.setNumber < SETS_PER_ROUND
        ? { kind: "Focus", round: phase.round, setNumber: phase.setNumber + 1 }
        : { kind: "Break", round: phase.round };
    case "Break":
      return { kind: "Focus", round: phase.round + 1, setNumber: 1 };
  }
};

/** 集中を最後まで終えたセットを完了セットとして残す。集中のほかのフェーズが終わっても何も残さない */
const setsAfterPhaseEnded = (
  phase: Phase,
  sets: ReadonlyArray<SetRecord>,
  endedAt: number,
): ReadonlyArray<SetRecord> =>
  phase.kind === "Focus"
    ? [
        ...sets,
        { kind: "CompletedSet", round: phase.round, setNumber: phase.setNumber, at: endedAt },
      ]
    : sets;

/** 集中の途中で中断・終了したセットを、不成立セットとして残す。集中の途中でなければ何も残さない */
const setsAfterInterrupted = (progress: Progress, t: number): ReadonlyArray<SetRecord> =>
  (progress.kind === "Running" || progress.kind === "Paused") && progress.phase.kind === "Focus"
    ? [
        ...progress.sets,
        {
          kind: "AbortedSet",
          round: progress.phase.round,
          setNumber: progress.phase.setNumber,
          at: t,
        },
      ]
    : progress.sets;

const completedSetCountOf = (sets: ReadonlyArray<SetRecord>): number =>
  sets.filter((set) => set.kind === "CompletedSet").length;

/**
 * 時刻 `t` までに終わったフェーズを、次のフェーズへ切り替える。
 * 進め方 `mode` がその切り替わりを手動にしていれば、終わった時刻から切り替え待ちで止まる
 */
const advanceTo = (progress: Progress, t: number, mode: AdvanceMode): Progress => {
  if (progress.kind !== "Running") {
    return progress;
  }
  const endsAt = progress.phaseStartedAt + phaseDurationMsOf(progress.phase);
  if (endsAt > t) {
    return progress;
  }
  const next = nextPhase(progress.phase);
  const sets = setsAfterPhaseEnded(progress.phase, progress.sets, endsAt);
  if (AdvanceMode.isManual(mode, progress.phase.kind, next.kind)) {
    return { kind: "Awaiting", finished: progress.phase, sets, since: endsAt };
  }
  return advanceTo({ kind: "Running", phase: next, sets, phaseStartedAt: endsAt }, t, mode);
};

/** 切り替え待ちから、時刻 `t` に次のフェーズを始める */
const startNextPhase = (
  awaiting: Extract<Progress, Readonly<{ kind: "Awaiting" }>>,
  t: number,
): Progress => ({
  kind: "Running",
  phase: nextPhase(awaiting.finished),
  sets: awaiting.sets,
  phaseStartedAt: t,
});

const stateKindOf = (progress: Progress): TimerState["kind"] => {
  switch (progress.kind) {
    case "Idle":
    case "Ended":
      return progress.kind;
    case "Awaiting":
      return "AwaitingAdvance";
    case "Running":
    case "Paused":
      return progress.phase.kind;
  }
};

const startFocus = (
  round: number,
  setNumber: number,
  sets: ReadonlyArray<SetRecord>,
  t: number,
): Progress => ({
  kind: "Running",
  phase: { kind: "Focus", round, setNumber },
  sets,
  phaseStartedAt: t,
});

/** 終了。集中の途中なら、そのセットは完了セットに数えていないので不成立セットになる */
const end = (progress: Progress, t: number, endedBy: "End" | "AutoEnd"): Progress => ({
  kind: "Ended",
  endedAt: t,
  endedBy,
  sets: setsAfterInterrupted(progress, t),
});

/** 時刻 `operation.at` まで進めた状態に、人の操作を当てはめる */
const applyOperation = (
  progress: Progress,
  operation: SessionOperation,
): Result.Result<Progress, DeriveTimerStateError> => {
  const t = operation.at.getTime();
  const accept = (next: Progress): Result.Result<Progress, DeriveTimerStateError> =>
    Result.succeed(next);
  const reject = (): Result.Result<Progress, DeriveTimerStateError> =>
    Result.fail({
      kind: "OperationRejected",
      operation: operation.kind,
      at: operation.at,
      during: stateKindOf(progress),
    });

  switch (operation.kind) {
    case "Pause":
      // どのフェーズでも一時停止できる。待機中はフェーズがないのでできない
      return progress.kind === "Running"
        ? accept({
            kind: "Paused",
            phase: progress.phase,
            sets: progress.sets,
            elapsedMs: t - progress.phaseStartedAt,
            pausedAt: t,
          })
        : reject();
    case "Resume":
      return progress.kind === "Paused"
        ? accept({
            kind: "Running",
            phase: progress.phase,
            sets: progress.sets,
            phaseStartedAt: t - progress.elapsedMs,
          })
        : reject();
    case "Abort":
      // 中断は集中中のみ（一時停止中の集中を含む）。待機に戻り、同じセット番号でやり直す
      return (progress.kind === "Running" || progress.kind === "Paused") &&
        progress.phase.kind === "Focus"
        ? accept({
            kind: "Idle",
            round: progress.phase.round,
            setNumber: progress.phase.setNumber,
            sets: setsAfterInterrupted(progress, t),
          })
        : reject();
    case "RestartFocus":
      return progress.kind === "Idle"
        ? accept(startFocus(progress.round, progress.setNumber, progress.sets, t))
        : reject();
    case "SkipBreak":
      // 休憩スキップは休憩中（一時停止中の休憩を含む）と、休憩に入る前の切り替え待ちのみ。
      // 次のラウンドの集中がすぐ始まる
      if (
        (progress.kind === "Running" || progress.kind === "Paused") &&
        progress.phase.kind === "Break"
      ) {
        return accept(startFocus(progress.phase.round + 1, 1, progress.sets, t));
      }
      if (progress.kind === "Awaiting") {
        const next = nextPhase(progress.finished);
        return next.kind === "Break"
          ? accept(startFocus(next.round + 1, 1, progress.sets, t))
          : reject();
      }
      return reject();
    case "Advance":
      // 進めるのは切り替え待ちのみ。押した時刻から次のフェーズが始まる
      return progress.kind === "Awaiting" ? accept(startNextPhase(progress, t)) : reject();
    case "End":
      return progress.kind === "Ended" ? reject() : accept(end(progress, t, "End"));
  }
};

/**
 * 記入も操作もないまま 2ラウンド分が過ぎていたら、最後の記入・操作の時刻で自動終了する。
 * その時刻に終了したのと同じ扱いなので、それより後に終わるはずだったセットは数えない。
 */
const autoEndIfInactiveUntil = (derivation: Derivation, t: number): Derivation =>
  derivation.progress.kind !== "Ended" && t - derivation.lastActivityAt >= AUTO_END_AFTER_MS
    ? {
        ...derivation,
        progress: end(
          advanceTo(derivation.progress, derivation.lastActivityAt, derivation.mode),
          derivation.lastActivityAt,
          "AutoEnd",
        ),
      }
    : derivation;

/**
 * 時刻 `t` に進め方を `mode` に変えたあとの状態。待っている切り替わりが自動になったら、
 * その時刻から次のフェーズを始める（ADR 0015）
 */
const applyAdvanceMode = (progress: Progress, mode: AdvanceMode, t: number): Progress =>
  progress.kind === "Awaiting" &&
  !AdvanceMode.isManual(mode, progress.finished.kind, nextPhase(progress.finished).kind)
    ? startNextPhase(progress, t)
    : progress;

const applyActivity = (
  derivation: Derivation,
  activity: Activity,
): Result.Result<Derivation, DeriveTimerStateError> => {
  switch (activity.kind) {
    case "JournalEntry": {
      const at = activity.at.getTime();
      const current = autoEndIfInactiveUntil(derivation, at);
      return Result.succeed(
        current.progress.kind === "Ended"
          ? current
          : { ...current, lastActivityAt: Math.max(current.lastActivityAt, at) },
      );
    }
    case "Operation": {
      const at = activity.operation.at.getTime();
      const current = autoEndIfInactiveUntil(derivation, at);
      return Result.pipe(
        applyOperation(advanceTo(current.progress, at, current.mode), activity.operation),
        Result.map((progress): Derivation => ({ ...current, progress, lastActivityAt: at })),
      );
    }
    case "AdvanceModeChanged": {
      const at = activity.change.at.getTime();
      const current = autoEndIfInactiveUntil(derivation, at);
      if (current.progress.kind === "Ended") {
        return Result.succeed(current);
      }
      const { mode } = activity.change;
      return Result.succeed({
        progress: applyAdvanceMode(advanceTo(current.progress, at, current.mode), mode, at),
        lastActivityAt: at,
        mode,
      });
    }
  }
};

const ensureChronological = (
  events: SessionEvents,
): Result.Result<SessionEvents, DeriveTimerStateError> => {
  const outOfOrder = events.find(
    (event, i) => event.at.getTime() < (events[i - 1]?.at.getTime() ?? Number.NEGATIVE_INFINITY),
  );
  return outOfOrder === undefined
    ? Result.succeed(events)
    : Result.fail({ kind: "EventOutOfOrder", at: outOfOrder.at });
};

/** セッションを始めた時刻 `startedAt` より後で、時刻 `now` までのもの。同じ時刻なら進め方の変更を先にする */
const activitiesBetween = (
  inputs: DerivationInputs,
  startedAt: number,
  now: Date,
): ReadonlyArray<Activity> =>
  [
    ...inputs.advanceModeChanges
      .filter((change) => change.at.getTime() > startedAt)
      .map((change): Activity => ({ kind: "AdvanceModeChanged", change })),
    ...inputs.operations.map((operation): Activity => ({ kind: "Operation", operation })),
    ...inputs.journalEntryTimes.map((at): Activity => ({ kind: "JournalEntry", at })),
  ]
    .filter((activity) => atOf(activity) <= now.getTime())
    .toSorted((a, b) => atOf(a) - atOf(b));

const atOf = (activity: Activity): number => {
  switch (activity.kind) {
    case "Operation":
      return activity.operation.at.getTime();
    case "JournalEntry":
      return activity.at.getTime();
    case "AdvanceModeChanged":
      return activity.change.at.getTime();
  }
};

type DerivationInputs = Readonly<{
  operations: ReadonlyArray<SessionOperation>;
  journalEntryTimes: ReadonlyArray<Date>;
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>;
}>;

// `new Date(ms)` は現在時刻を読まないので純粋（AGENTS.md の禁止は引数なしの `new Date()`）
const toTimerState = (progress: Progress, now: number): TimerState => {
  const remainingSeconds = (ms: number) => Math.ceil(ms / 1000);
  const inPhase = (phase: Phase, completedSets: number, remainingMs: number, clock: Clock) => {
    switch (phase.kind) {
      case "Focus":
      case "Journal":
        return {
          kind: phase.kind,
          round: phase.round,
          setNumber: phase.setNumber,
          completedSets,
          remainingSeconds: remainingSeconds(remainingMs),
          clock,
        };
      case "Break":
        return {
          kind: phase.kind,
          round: phase.round,
          completedSets,
          remainingSeconds: remainingSeconds(remainingMs),
          clock,
        };
    }
  };

  const completedSets = completedSetCountOf(progress.sets);
  switch (progress.kind) {
    case "Idle":
      return {
        kind: "Idle",
        round: progress.round,
        setNumber: progress.setNumber,
        completedSets,
      };
    case "Running": {
      const endsAt = progress.phaseStartedAt + phaseDurationMsOf(progress.phase);
      return inPhase(progress.phase, completedSets, endsAt - now, {
        kind: "Running",
        endsAt: new Date(endsAt),
      });
    }
    case "Paused":
      return inPhase(
        progress.phase,
        completedSets,
        phaseDurationMsOf(progress.phase) - progress.elapsedMs,
        { kind: "Paused", pausedAt: new Date(progress.pausedAt) },
      );
    case "Awaiting":
      return {
        kind: "AwaitingAdvance",
        finished: progress.finished,
        completedSets,
        since: new Date(progress.since),
      };
    case "Ended":
      return {
        kind: "Ended",
        endedAt: new Date(progress.endedAt),
        endedBy: progress.endedBy,
        completedSets,
      };
  }
};

/** 時刻 `now` までの操作イベントとジャーナル記入を順に当てはめ、`now` まで進めた途中の状態 */
const progressAt = (
  events: SessionEvents,
  now: Date,
  journalEntryTimes: ReadonlyArray<Date>,
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>,
): Result.Result<Progress, DeriveTimerStateError> => {
  const [start, ...operations] = events;
  const startedAt = start.at.getTime();
  const initial: Derivation = {
    progress: startFocus(1, 1, [], startedAt),
    lastActivityAt: startedAt,
    mode: AdvanceModeChange.modeAt(advanceModeChanges, start.at),
  };
  const inputs: DerivationInputs = { operations, journalEntryTimes, advanceModeChanges };

  return Result.pipe(
    ensureChronological(events),
    Result.andThen(() =>
      activitiesBetween(inputs, startedAt, now).reduce<
        Result.Result<Derivation, DeriveTimerStateError>
      >(
        (derived, activity) =>
          Result.pipe(
            derived,
            Result.andThen((derivation) => applyActivity(derivation, activity)),
          ),
        Result.succeed(initial),
      ),
    ),
    Result.map((derivation) => {
      const t = now.getTime();
      const current = autoEndIfInactiveUntil(derivation, t);
      return advanceTo(current.progress, t, current.mode);
    }),
  );
};

/**
 * 操作イベントと時刻から、時刻 `now` のタイマーの状態を計算する（ADR 0003）。
 *
 * フェーズの自動的な切り替わりは記録されていないので、ここで時刻から計算する。
 * `now` より後の操作イベントとジャーナル記入は、まだ起きていないものとして扱わない。
 *
 * - `journalEntryTimes`: このセッションのジャーナル記入の時刻。自動終了の判断にだけ使う
 * - `advanceModeChanges`: フェーズの進め方の変更履歴（時刻の順）。セッションを始めた時刻に効いていた変更を含める（ADR 0015）
 * - その状態ではできない操作が含まれていれば `OperationRejected` を返す。
 *   新しい操作を受け付けてよいかは、記録済みのイベントに足して計算し直せば判断できる
 */
export const deriveTimerState = (
  events: SessionEvents,
  now: Date,
  journalEntryTimes: ReadonlyArray<Date>,
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>,
): Result.Result<TimerState, DeriveTimerStateError> =>
  Result.pipe(
    progressAt(events, now, journalEntryTimes, advanceModeChanges),
    Result.map((progress) => toTimerState(progress, now.getTime())),
  );

/**
 * 時刻 `now` までに完了セットになったセットの、集中を終えた時刻（古い順）。
 *
 * タイムラインで、日付ごとの完了セット数を数えるのに使う。完了セットはその集中を終えた時刻の日付に数える。
 * 計算は `deriveTimerState` と同じなので、数は `TimerState` の `completedSets` と必ず一致する。
 */
export const deriveCompletedSetTimes = (
  events: SessionEvents,
  now: Date,
  journalEntryTimes: ReadonlyArray<Date>,
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>,
): Result.Result<ReadonlyArray<Date>, DeriveTimerStateError> =>
  Result.pipe(
    progressAt(events, now, journalEntryTimes, advanceModeChanges),
    Result.map((progress) =>
      progress.sets.filter((set) => set.kind === "CompletedSet").map((set) => new Date(set.at)),
    ),
  );

/**
 * 時刻 `now` までのセットの結末（完了セットと不成立セット）を、時刻の古い順に並べたもの。
 * セッションのまとめで、セットの並びを出すのに使う。計算は `deriveTimerState` と同じ。
 */
export const deriveSetOutcomes = (
  events: SessionEvents,
  now: Date,
  journalEntryTimes: ReadonlyArray<Date>,
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>,
): Result.Result<ReadonlyArray<SetOutcome>, DeriveTimerStateError> =>
  Result.pipe(
    progressAt(events, now, journalEntryTimes, advanceModeChanges),
    Result.map((progress) =>
      progress.sets.map(({ at, ...set }): SetOutcome => ({ ...set, at: new Date(at) })),
    ),
  );

/**
 * 記入も操作もないまま過ぎれば自動終了する時刻（最後の記入・操作から2ラウンド分の位置）。
 * フェーズの進め方の変更も操作として数える（ADR 0015）。
 *
 * 自動終了そのものは `deriveTimerState` が時刻から計算する。サーバーはこの時刻に alarm を張り、
 * 記入や操作があるたびに張り直すことで、誰も見ていなくても自動終了を記録に残す。
 */
export const autoEndDueAt = (
  events: SessionEvents,
  journalEntryTimes: ReadonlyArray<Date>,
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>,
): Date =>
  new Date(
    Math.max(
      ...events.map((event) => event.at.getTime()),
      ...journalEntryTimes.map((at) => at.getTime()),
      // 始める前の変更は自動終了の時刻を延ばさない（始めた時刻のほうが後）
      ...advanceModeChanges.map((change) => change.at.getTime()),
    ) + AUTO_END_AFTER_MS,
  );
