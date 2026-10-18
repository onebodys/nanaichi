import type { ReactNode } from "react";
import type { InPhase } from "../domain/phase-change.ts";
import {
  remainingRatioOf,
  roundProgressOf,
  upcomingPhaseOf,
  type RoundProgress,
  type Segment,
} from "../domain/round-progress.ts";
import type { SessionOperation } from "../domain/session-event.ts";
import { SessionSummary, type EntryCount } from "../domain/session-summary.ts";
import type { Session } from "../domain/session.ts";
import {
  nextPhase,
  type Ended,
  type Phase,
  type SetOutcome,
  type TimerState,
} from "../domain/timer-state.ts";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";
import { operationButtonsOf } from "./operation-layout.ts";
import { focusTimeLabelOf } from "./focus-time-text.ts";
import {
  abortedSetsNoteOf,
  advanceLabelOf,
  awaitingLabelOf,
  countdownPartsOf,
  currentSessionLabelOf,
  endedMessageOf,
  idleMessageOf,
  operationLabelOf,
  pausedForLabelOf,
  phaseLabelOf,
  positionOf,
  sessionRhythmOf,
  sessionSpanLabelOf,
  untilBreakLabelOf,
  upcomingLabelOf,
} from "./timer-text.ts";
import type { SessionTimer, TimerView } from "./use-session-timer.ts";
import { useWakeLock } from "./wake-lock.ts";

type InSessionState = Exclude<TimerState, Ended>;
type AwaitingAdvance = Extract<TimerState, Readonly<{ kind: "AwaitingAdvance" }>>;

/** フェーズの色（index.css のトークン）。Tailwind が拾えるよう、クラス名は省略せずに書く */
type Tone = Readonly<{ text: string; soft: string; fill: string; stroke: string; solid: string }>;

const TONES = {
  Focus: {
    text: "text-focus",
    soft: "bg-focus-soft",
    fill: "bg-focus-mark",
    stroke: "stroke-focus-mark",
    solid: "bg-focus text-focus-foreground hover:bg-focus/85",
  },
  Journal: {
    text: "text-journal",
    soft: "bg-journal-soft",
    fill: "bg-journal-mark",
    stroke: "stroke-journal-mark",
    solid: "bg-journal text-journal-foreground hover:bg-journal/85",
  },
  Break: {
    text: "text-break",
    soft: "bg-break-soft",
    fill: "bg-break-mark",
    stroke: "stroke-break-mark",
    solid: "bg-break text-break-foreground hover:bg-break/85",
  },
  Idle: {
    text: "text-muted-foreground",
    soft: "bg-muted",
    fill: "bg-muted-foreground/60",
    stroke: "stroke-muted-foreground",
    solid: "bg-primary text-primary-foreground hover:bg-primary/85",
  },
} as const satisfies Record<Phase["kind"] | "Idle", Tone>;

/** 状態の色。切り替え待ちは、これから始まるフェーズの色 */
const toneOf = (state: InSessionState): Tone =>
  state.kind === "AwaitingAdvance" ? TONES[nextPhase(state.finished).kind] : TONES[state.kind];

/**
 * 主な操作のボタンの色。集中の再開始は集中、休憩スキップは休憩の色、それ以外（再開・進める）は
 * いまのフェーズ（切り替え待ちなら、これから始まるフェーズ）の色。一時停止を主にするときは色をつけない（`undefined`）
 */
const primaryToneOf = (kind: SessionOperation["kind"], state: InSessionState): Tone | undefined => {
  switch (kind) {
    case "RestartFocus":
      return TONES.Focus;
    case "SkipBreak":
      return TONES.Break;
    case "Resume":
    case "Advance":
      return toneOf(state);
    case "Pause":
    case "Abort":
    case "End":
      return undefined;
  }
};

const isPaused = (state: InSessionState): boolean =>
  state.kind !== "Idle" && state.kind !== "AwaitingAdvance" && state.clock.kind === "Paused";

/** 操作ボタンの文言。進めるは、何が始まるかで言う */
const operationButtonLabelOf = (kind: SessionOperation["kind"], state: InSessionState): string =>
  kind === "Advance" && state.kind === "AwaitingAdvance"
    ? advanceLabelOf(nextPhase(state.finished))
    : operationLabelOf(kind);

// ---------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------

const RING_RADIUS = 160;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** PC で出す円。`children` に残り時間の弧を重ねる。スマホでは出さない */
const Dial = ({
  dashed = false,
  children,
}: Readonly<{ dashed?: boolean; children?: ReactNode }>) => (
  <svg
    viewBox="0 0 340 340"
    aria-hidden
    className="pointer-events-none absolute inset-0 hidden size-full lg:block"
  >
    <circle
      cx="170"
      cy="170"
      r={RING_RADIUS}
      fill="none"
      strokeWidth="6"
      className="stroke-border"
      strokeDasharray={dashed ? "4 10" : undefined}
    />
    {children}
  </svg>
);

const RemainingArc = ({
  ratio,
  tone,
  dimmed,
}: Readonly<{ ratio: number; tone: Tone; dimmed: boolean }>) => (
  <circle
    cx="170"
    cy="170"
    r={RING_RADIUS}
    fill="none"
    strokeWidth="6"
    strokeLinecap="round"
    strokeDasharray={`${ratio * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
    transform="rotate(-90 170 170)"
    className={cn(
      tone.stroke,
      "transition-[stroke-dasharray] duration-500",
      dimmed && "opacity-40",
    )}
  />
);

/** カウントダウン。等幅の数字のまま「:」だけ幅を詰める */
const Countdown = ({
  remainingSeconds,
  dimmed,
  label = true,
}: Readonly<{ remainingSeconds: number; dimmed: boolean; label?: boolean }>) => {
  const { minutes, seconds } = countdownPartsOf(remainingSeconds);
  return (
    <p
      role={label ? "timer" : undefined}
      aria-label={label ? "残り時間" : undefined}
      className={cn(
        "relative font-mono text-[56px] leading-none font-light tracking-[-0.03em] tabular-nums lg:text-[88px]",
        dimmed && "text-muted-foreground",
      )}
    >
      <span>{minutes}</span>
      <span className="-mx-[0.14em]">:</span>
      <span>{seconds}</span>
    </p>
  );
};

const SegmentBar = ({
  segment,
  fill,
  className,
}: Readonly<{ segment: Segment; fill: string; className: string }>) => (
  <span className={cn("overflow-hidden rounded-full bg-border", className)}>
    {segment.kind !== "Pending" && (
      <span
        className={cn("block h-full", fill)}
        style={{ width: segment.kind === "Done" ? "100%" : `${segment.elapsedRatio * 100}%` }}
      />
    )}
  </span>
);

/** ラウンドの進み具合（3つのセットと休憩） */
const RoundBar = ({ progress }: Readonly<{ progress: RoundProgress }>) => {
  const untilBreak = untilBreakLabelOf(progress);
  return (
    <div className="flex items-center gap-1 lg:gap-1.5">
      <div aria-hidden className="flex flex-1 items-center gap-1 lg:flex-none lg:gap-1.5">
        {progress.sets.map((segment, i) => (
          <SegmentBar
            key={i}
            segment={segment}
            fill={TONES.Focus.fill}
            className="h-1 flex-1 lg:h-1.5 lg:w-11 lg:flex-none"
          />
        ))}
        <SegmentBar
          segment={progress.break}
          fill={TONES.Break.fill}
          className="ml-1 h-1 flex-[0.5] lg:ml-1.5 lg:h-1.5 lg:w-5 lg:flex-none"
        />
      </div>
      {untilBreak !== undefined && (
        <span className="ml-2 hidden text-xs text-muted-foreground lg:inline">{untilBreak}</span>
      )}
    </div>
  );
};

const PhasePill = ({ state }: Readonly<{ state: InSessionState }>) => {
  const tone = toneOf(state);
  // 一時停止中と切り替え待ちは、止まっていることを中抜きの点で示す
  const paused = isPaused(state) || state.kind === "AwaitingAdvance";
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold lg:px-3.5 lg:py-1.5 lg:text-[15px]",
        tone.soft,
        tone.text,
      )}
    >
      <span
        aria-hidden
        className={cn("size-2 rounded-full", paused ? "border-2 border-current" : tone.fill)}
      />
      <h2>{phaseLabelOf(state)}</h2>
      {isPaused(state) && (
        <>
          <span aria-hidden>·</span>
          <span>一時停止中</span>
        </>
      )}
    </div>
  );
};

const Operations = ({
  state,
  operations,
  pending,
  operate,
}: Readonly<{
  state: InSessionState;
  operations: ReadonlyArray<SessionOperation["kind"]>;
  pending: boolean;
  operate: (kind: SessionOperation["kind"]) => void;
}>) => (
  <div className="flex gap-2 lg:gap-2.5">
    {operationButtonsOf(operations).map(({ kind, emphasis }) => (
      <Button
        key={kind}
        variant={emphasis === "Secondary" ? "outline" : emphasis === "Quiet" ? "ghost" : "default"}
        onClick={() => operate(kind)}
        disabled={pending}
        className={cn(
          "h-11 rounded-xl px-4 text-sm lg:h-12 lg:px-6 lg:text-[15px]",
          emphasis === "Primary" && "flex-1 font-semibold lg:flex-none lg:px-7",
          emphasis === "Primary" && primaryToneOf(kind, state)?.solid,
          emphasis === "Quiet" && "px-3 text-muted-foreground",
        )}
      >
        {operationButtonLabelOf(kind, state)}
      </Button>
    ))}
  </div>
);

/** スマホではカードに、PC では左のペインいっぱいに中央寄せで置く入れ物 */
const Stage = ({ children }: Readonly<{ children: ReactNode }>) => (
  <div className="flex w-full flex-col gap-3 rounded-2xl border bg-card p-4 lg:items-center lg:gap-7 lg:border-0 lg:bg-transparent lg:p-0">
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// 状態ごとの描画
// ---------------------------------------------------------------------------

const InPhaseBody = ({ state, now }: Readonly<{ state: InPhase; now: Date }>) => {
  const dimmed = state.clock.kind === "Paused";
  return (
    <div className="relative flex items-end justify-between lg:size-[340px] lg:flex-col lg:items-center lg:justify-center lg:gap-1">
      <Dial>
        <RemainingArc ratio={remainingRatioOf(state)} tone={TONES[state.kind]} dimmed={dimmed} />
      </Dial>
      <Countdown remainingSeconds={state.remainingSeconds} dimmed={dimmed} />
      <p className="relative pb-1.5 text-xs text-muted-foreground lg:pb-0 lg:text-sm">
        {state.clock.kind === "Paused"
          ? pausedForLabelOf(state.clock.pausedAt, now)
          : upcomingLabelOf(upcomingPhaseOf(state))}
      </p>
    </div>
  );
};

/** 切り替え待ち。0:00 で止まり、何が終わってどれだけ待っているかを出す。円はこれから始まるフェーズの色で満たす */
const AwaitingBody = ({ state, now }: Readonly<{ state: AwaitingAdvance; now: Date }>) => (
  <div className="relative flex items-end justify-between lg:size-[340px] lg:flex-col lg:items-center lg:justify-center lg:gap-1">
    <Dial>
      <RemainingArc ratio={1} tone={toneOf(state)} dimmed />
    </Dial>
    <Countdown remainingSeconds={0} dimmed={false} />
    <p className="relative pb-1.5 text-xs text-muted-foreground lg:pb-0 lg:text-sm">
      {awaitingLabelOf(state.finished, state.since, now)}
    </p>
  </div>
);

const IdleBody = ({ setNumber }: Readonly<{ setNumber: number }>) => {
  const { title, body } = idleMessageOf(setNumber);
  return (
    <div className="relative flex flex-col gap-1 lg:size-[340px] lg:items-center lg:justify-center lg:gap-2.5 lg:px-12 lg:text-center">
      <Dial dashed />
      <p className="relative font-semibold lg:text-[17px]">{title}</p>
      <p className="relative text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
};

const InSession = ({
  session,
  state,
  now,
  operations,
  pending,
  operate,
}: Readonly<{
  session: Session;
  state: InSessionState;
  now: Date;
  operations: ReadonlyArray<SessionOperation["kind"]>;
  pending: boolean;
  operate: (kind: SessionOperation["kind"]) => void;
}>) => (
  <Stage>
    <div className="flex flex-row-reverse items-center justify-between lg:flex-col lg:gap-2.5">
      <p className="text-xs text-muted-foreground lg:text-sm">{positionOf(state)}</p>
      <PhasePill state={state} />
    </div>
    {state.kind === "Idle" ? (
      <IdleBody setNumber={state.setNumber} />
    ) : state.kind === "AwaitingAdvance" ? (
      <AwaitingBody state={state} now={now} />
    ) : (
      <InPhaseBody state={state} now={now} />
    )}
    <RoundBar progress={roundProgressOf(state)} />
    <Operations state={state} operations={operations} pending={pending} operate={operate} />
    <p className="hidden text-sm text-muted-foreground lg:block">
      {currentSessionLabelOf(session.events[0].at, state.completedSets)}
    </p>
  </Stage>
);

const StartButton = ({
  start,
  pending,
  label = "開始",
}: Readonly<{ start: () => void; pending: boolean; label?: string }>) => (
  <Button
    onClick={start}
    disabled={pending}
    className={cn(
      "h-12 w-full rounded-xl text-base font-semibold lg:h-14 lg:w-auto lg:px-12 lg:text-[17px]",
      TONES.Focus.solid,
    )}
  >
    {label}
  </Button>
);

const NoSession = ({ start, pending }: Readonly<{ start: () => void; pending: boolean }>) => {
  const rhythm = sessionRhythmOf();
  return (
    <Stage>
      <p className="text-sm text-muted-foreground lg:text-[15px]">セッションを始める</p>
      <div className="relative flex items-end justify-between lg:size-[340px] lg:flex-col lg:items-center lg:justify-center lg:gap-1">
        <Dial />
        <Countdown remainingSeconds={rhythm.focusSeconds} dimmed label={false} />
        <p className="relative pb-1.5 text-xs text-muted-foreground lg:pb-0 lg:text-sm">
          {rhythm.set}
        </p>
      </div>
      <StartButton start={start} pending={pending} />
      <p className="text-xs text-muted-foreground lg:text-sm">{rhythm.round}</p>
    </Stage>
  );
};

/** セットの並び。ラウンドごとに間をあけ、不成立セットは点線で出す */
const SetSequence = ({ sets }: Readonly<{ sets: ReadonlyArray<SetOutcome> }>) => {
  const rounds = [...new Set(sets.map((set) => set.round))];
  return (
    <div aria-hidden className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5">
      {rounds.map((round) => (
        <div key={round} className="flex gap-1">
          {sets
            .filter((set) => set.round === round)
            .map((set, i) => (
              <span
                key={i}
                className={cn(
                  "h-2 w-5.5 rounded-[3px]",
                  set.kind === "CompletedSet"
                    ? TONES.Focus.fill
                    : "border-[1.5px] border-dashed border-muted-foreground",
                )}
              />
            ))}
        </div>
      ))}
    </div>
  );
};

const SummaryStat = ({ value, label }: Readonly<{ value: string; label: string }>) => (
  <div className="flex flex-1 flex-col items-center gap-0.5">
    <span className="font-mono text-xl lg:text-[26px]">{value}</span>
    <span className="text-xs text-muted-foreground">{label}</span>
  </div>
);

const EndedBody = ({
  summary,
  start,
  pending,
}: Readonly<{ summary: SessionSummary; start: () => void; pending: boolean }>) => {
  const abortedNote = abortedSetsNoteOf(summary.abortedSets);
  return (
    <Stage>
      <div className="flex flex-col gap-1 lg:items-center lg:gap-2">
        <p className="text-xs text-muted-foreground lg:text-sm">
          {endedMessageOf(summary.endedBy)}
        </p>
        <h2 className="text-lg font-bold lg:text-2xl">おつかれさまでした</h2>
        <p className="text-xs text-muted-foreground lg:text-sm">
          {sessionSpanLabelOf(summary.startedAt, summary.endedAt)}
        </p>
      </div>
      <section
        aria-label="セッションのまとめ"
        className="flex w-full flex-col gap-4 rounded-xl bg-muted px-4 py-4 lg:w-[400px] lg:gap-5 lg:rounded-2xl lg:border lg:bg-card lg:p-6"
      >
        <div className="flex">
          <SummaryStat value={focusTimeLabelOf(summary.focusTimeMs)} label="集中" />
          <SummaryStat value={String(summary.completedSets)} label="完了セット" />
          <SummaryStat
            value={summary.entries.kind === "Counted" ? String(summary.entries.count) : "—"}
            label="記入"
          />
        </div>
        {summary.sets.length > 0 && <SetSequence sets={summary.sets} />}
        {abortedNote !== undefined && (
          <p className="text-center text-xs text-muted-foreground">{abortedNote}</p>
        )}
      </section>
      <StartButton start={start} pending={pending} label="次のセッションを開始" />
    </Stage>
  );
};

const Body = ({
  view,
  now,
  entries,
  pending,
  start,
  operate,
  reload,
}: Readonly<{
  view: TimerView;
  now: Date;
  entries: EntryCount;
  pending: boolean;
  start: () => void;
  operate: (kind: SessionOperation["kind"]) => void;
  reload: () => void;
}>) => {
  switch (view.kind) {
    case "Loading":
      return <p className="text-sm text-muted-foreground">読み込み中…</p>;
    case "LoadFailed":
      return (
        <div className="flex flex-col items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            タイマーを読み込めませんでした
          </p>
          <Button variant="outline" onClick={reload}>
            読み込み直す
          </Button>
        </div>
      );
    case "NoSession":
      return <NoSession start={start} pending={pending} />;
    case "Ended":
      return (
        <EndedBody
          summary={SessionSummary.of({ session: view.session, ended: view.state, now, entries })}
          start={start}
          pending={pending}
        />
      );
    case "InSession":
      return (
        <InSession
          session={view.session}
          state={view.state}
          now={now}
          operations={view.operations}
          pending={pending}
          operate={operate}
        />
      );
  }
};

/**
 * タイマー（docs/PRODUCT.md「画面」）。PC では左のペインに、スマホでは上のカードに置く（Issue #34 の A 案）。
 * カウントダウン、フェーズ、何ラウンド目・何セット目か、ラウンドの進み具合、その状態でできる操作を出す。
 * 状態の計算と判断は `useSessionTimer`（ホーム画面が持つ）とドメインにある。
 */
export const TimerPanel = ({
  timer,
  entries,
  className,
}: Readonly<{
  timer: SessionTimer;
  /** 終了したセッションの記入の数（セッションのまとめに出す） */
  entries: EntryCount;
  className?: string;
}>) => {
  const { view, serverNow, pending, errorMessage, start, operate, reload } = timer;
  // セッション中（待機・一時停止を含む）は画面を消灯させない
  useWakeLock(view.kind === "InSession");

  return (
    <section aria-label="タイマー" className={cn("flex flex-col items-center gap-3", className)}>
      <Body
        view={view}
        now={serverNow}
        entries={entries}
        pending={pending}
        start={start}
        operate={operate}
        reload={reload}
      />
      {errorMessage !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}
    </section>
  );
};
