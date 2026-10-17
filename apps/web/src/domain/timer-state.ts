import { Result } from "@praha/byethrow";
import type { SessionEvents, SessionOperation } from "./session-event.ts";

// MVP では時間とセット数のカスタム設定を作らないので固定する（docs/PRODUCT.md「タイマー」）。
const MINUTE_MS = 60_000;
const FOCUS_MS = 7 * MINUTE_MS;
const JOURNAL_MS = 1 * MINUTE_MS;
const BREAK_MS = 5 * MINUTE_MS;
const SETS_PER_ROUND = 3;
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

export type Ended = Readonly<{
  kind: "Ended";
  endedAt: Date;
  endedBy: "End" | "AutoEnd";
  completedSets: number;
}>;

export type TimerState = Idle | Focus | Journal | Break | Ended;

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

type Phase =
  | Readonly<{ kind: "Focus"; round: number; setNumber: number }>
  | Readonly<{ kind: "Journal"; round: number; setNumber: number }>
  | Readonly<{ kind: "Break"; round: number }>;

type Progress =
  | Readonly<{ kind: "Idle"; round: number; setNumber: number; completedSets: number }>
  /** `phaseStartedAt` は一時停止していた時間の分だけ後ろにずらした、見かけのフェーズ開始時刻 */
  | Readonly<{ kind: "Running"; phase: Phase; completedSets: number; phaseStartedAt: number }>
  | Readonly<{
      kind: "Paused";
      phase: Phase;
      completedSets: number;
      elapsedMs: number;
      pausedAt: number;
    }>
  | Readonly<{
      kind: "Ended";
      endedAt: number;
      endedBy: "End" | "AutoEnd";
      completedSets: number;
    }>;

type Derivation = Readonly<{ progress: Progress; lastActivityAt: number }>;

/** 時刻の順に処理するもの。ジャーナル記入は状態を変えないが、自動終了までの時間を延ばす */
type Activity =
  | Readonly<{ kind: "Operation"; operation: SessionOperation }>
  | Readonly<{ kind: "JournalEntry"; at: Date }>;

const durationOf = (phase: Phase): number => {
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
const nextPhase = (phase: Phase): Phase => {
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

/** 集中を最後まで終えたセットだけを完了セットとして数える */
const completedSetsAfter = (phase: Phase, completedSets: number): number =>
  phase.kind === "Focus" ? completedSets + 1 : completedSets;

/** 時刻 `t` までに終わったフェーズを、自動的に次のフェーズへ切り替える */
const advanceTo = (progress: Progress, t: number): Progress => {
  if (progress.kind !== "Running") {
    return progress;
  }
  const endsAt = progress.phaseStartedAt + durationOf(progress.phase);
  if (endsAt > t) {
    return progress;
  }
  return advanceTo(
    {
      kind: "Running",
      phase: nextPhase(progress.phase),
      completedSets: completedSetsAfter(progress.phase, progress.completedSets),
      phaseStartedAt: endsAt,
    },
    t,
  );
};

const stateKindOf = (progress: Progress): TimerState["kind"] => {
  switch (progress.kind) {
    case "Idle":
    case "Ended":
      return progress.kind;
    case "Running":
    case "Paused":
      return progress.phase.kind;
  }
};

const startFocus = (
  round: number,
  setNumber: number,
  completedSets: number,
  t: number,
): Progress => ({
  kind: "Running",
  phase: { kind: "Focus", round, setNumber },
  completedSets,
  phaseStartedAt: t,
});

/** 終了。集中の途中なら、そのセットは完了セットに数えていないので不成立セットになる */
const end = (progress: Progress, t: number, endedBy: "End" | "AutoEnd"): Progress => ({
  kind: "Ended",
  endedAt: t,
  endedBy,
  completedSets: progress.completedSets,
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
            completedSets: progress.completedSets,
            elapsedMs: t - progress.phaseStartedAt,
            pausedAt: t,
          })
        : reject();
    case "Resume":
      return progress.kind === "Paused"
        ? accept({
            kind: "Running",
            phase: progress.phase,
            completedSets: progress.completedSets,
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
            completedSets: progress.completedSets,
          })
        : reject();
    case "RestartFocus":
      return progress.kind === "Idle"
        ? accept(startFocus(progress.round, progress.setNumber, progress.completedSets, t))
        : reject();
    case "SkipBreak":
      // 休憩スキップは休憩中のみ（一時停止中の休憩を含む）。次のラウンドの集中がすぐ始まる
      return (progress.kind === "Running" || progress.kind === "Paused") &&
        progress.phase.kind === "Break"
        ? accept(startFocus(progress.phase.round + 1, 1, progress.completedSets, t))
        : reject();
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
          advanceTo(derivation.progress, derivation.lastActivityAt),
          derivation.lastActivityAt,
          "AutoEnd",
        ),
      }
    : derivation;

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
        applyOperation(advanceTo(current.progress, at), activity.operation),
        Result.map((progress): Derivation => ({ progress, lastActivityAt: at })),
      );
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

const activitiesUntil = (
  operations: ReadonlyArray<SessionOperation>,
  journalEntryTimes: ReadonlyArray<Date>,
  now: Date,
): ReadonlyArray<Activity> =>
  [
    ...operations.map((operation): Activity => ({ kind: "Operation", operation })),
    ...journalEntryTimes.map((at): Activity => ({ kind: "JournalEntry", at })),
  ]
    .filter((activity) => atOf(activity) <= now.getTime())
    .toSorted((a, b) => atOf(a) - atOf(b));

const atOf = (activity: Activity): number =>
  activity.kind === "Operation" ? activity.operation.at.getTime() : activity.at.getTime();

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

  switch (progress.kind) {
    case "Idle":
      return progress;
    case "Running": {
      const endsAt = progress.phaseStartedAt + durationOf(progress.phase);
      return inPhase(progress.phase, progress.completedSets, endsAt - now, {
        kind: "Running",
        endsAt: new Date(endsAt),
      });
    }
    case "Paused":
      return inPhase(
        progress.phase,
        progress.completedSets,
        durationOf(progress.phase) - progress.elapsedMs,
        { kind: "Paused", pausedAt: new Date(progress.pausedAt) },
      );
    case "Ended":
      return {
        kind: "Ended",
        endedAt: new Date(progress.endedAt),
        endedBy: progress.endedBy,
        completedSets: progress.completedSets,
      };
  }
};

/**
 * 操作イベントと時刻から、時刻 `now` のタイマーの状態を計算する（ADR 0003）。
 *
 * フェーズの自動的な切り替わりは記録されていないので、ここで時刻から計算する。
 * `now` より後の操作イベントとジャーナル記入は、まだ起きていないものとして扱わない。
 *
 * - `journalEntryTimes`: このセッションのジャーナル記入の時刻。自動終了の判断にだけ使う
 * - その状態ではできない操作が含まれていれば `OperationRejected` を返す。
 *   新しい操作を受け付けてよいかは、記録済みのイベントに足して計算し直せば判断できる
 */
export const deriveTimerState = (
  events: SessionEvents,
  now: Date,
  journalEntryTimes: ReadonlyArray<Date>,
): Result.Result<TimerState, DeriveTimerStateError> => {
  const [start, ...operations] = events;
  const startedAt = start.at.getTime();
  const initial: Derivation = {
    progress: startFocus(1, 1, 0, startedAt),
    lastActivityAt: startedAt,
  };

  return Result.pipe(
    ensureChronological(events),
    Result.andThen(() =>
      activitiesUntil(operations, journalEntryTimes, now).reduce<
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
      return toTimerState(advanceTo(autoEndIfInactiveUntil(derivation, t).progress, t), t);
    }),
  );
};

/**
 * 記入も操作もないまま過ぎれば自動終了する時刻（最後の記入・操作から2ラウンド分の位置）。
 *
 * 自動終了そのものは `deriveTimerState` が時刻から計算する。サーバーはこの時刻に alarm を張り、
 * 記入や操作があるたびに張り直すことで、誰も見ていなくても自動終了を記録に残す。
 */
export const autoEndDueAt = (events: SessionEvents, journalEntryTimes: ReadonlyArray<Date>): Date =>
  new Date(
    Math.max(
      ...events.map((event) => event.at.getTime()),
      ...journalEntryTimes.map((at) => at.getTime()),
    ) + AUTO_END_AFTER_MS,
  );
