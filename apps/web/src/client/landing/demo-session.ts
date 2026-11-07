import { Result } from "@praha/byethrow";
import { AdvanceModeChange, type AdvanceMode } from "../../domain/advance-mode.ts";
import {
  JournalEntry,
  type JournalEntryBody,
  type JournalEntryId,
  type NoSessionInProgress,
} from "../../domain/journal-entry.ts";
import type { SessionEventId, SessionOperation } from "../../domain/session-event.ts";
import { Session, type SessionId } from "../../domain/session.ts";
import type { OperationRejected, TimerState } from "../../domain/timer-state.ts";

/**
 * LP で試せるタイマー（Issue #90、ADR 0024）。
 *
 * サーバーには何も送らず、ページの中だけで動く。状態の計算はアプリと同じドメイン（`Session`・`JournalEntry`）に
 * 任せるので、フェーズの切り替わりや操作できるかどうかはアプリと同じになる。
 * ページの時計を実時間の `speed` 倍で進められるようにし、1ラウンド（29分）を短い時間で見せられるようにする。
 * 時刻はすべて引数で受け取る（画面が `Date.now()` を渡す）。
 */

/**
 * ページの時計。始めた時刻 `startedAt`（実時間）からの経過を `speed` 倍して、セッションの時刻にする。
 * 始めた瞬間はセッションの時刻と実時間が一致する
 */
type DemoClock = Readonly<{ startedAt: Date; speed: number }>;

/**
 * - `NotStarted`: まだ始めていない。`mode` は始めるセッションに効かせるフェーズの進め方
 * - `Started`: セッションを始めた。終了したあとも、まとめを出すためにこの状態のまま持つ
 */
export type Demo =
  | Readonly<{ kind: "NotStarted"; mode: AdvanceMode }>
  | Readonly<{
      kind: "Started";
      session: Session;
      clock: DemoClock;
      /** 書いた記入。新しいものが先 */
      entries: ReadonlyArray<JournalEntry>;
    }>;

type Started = Extract<Demo, Readonly<{ kind: "Started" }>>;

/** ページの時計で、実時間 `realNow` のセッションの時刻 */
const sessionTimeOf = (clock: DemoClock, realNow: Date): Date =>
  new Date(
    clock.startedAt.getTime() + (realNow.getTime() - clock.startedAt.getTime()) * clock.speed,
  );

export const Demo = {
  initial: (mode: AdvanceMode): Demo => ({ kind: "NotStarted", mode }),

  /** セッションを始める。1ラウンド目の1セット目の集中がすぐに始まる */
  start: (
    demo: Demo,
    input: Readonly<{
      sessionId: SessionId;
      eventId: SessionEventId;
      realNow: Date;
      speed: number;
    }>,
  ): Started => ({
    kind: "Started",
    session: Session.start(input.sessionId, input.eventId, input.realNow, [
      { at: input.realNow, mode: Demo.modeAt(demo, input.realNow) },
    ]),
    clock: { startedAt: input.realNow, speed: input.speed },
    entries: [],
  }),

  /** 実時間 `realNow` のセッションの時刻。始めていなければ実時間のまま */
  timeAt: (demo: Demo, realNow: Date): Date => {
    switch (demo.kind) {
      case "NotStarted":
        return realNow;
      case "Started":
        return sessionTimeOf(demo.clock, realNow);
    }
  },

  stateAt: (demo: Started, realNow: Date): TimerState =>
    Session.stateAt(demo.session, sessionTimeOf(demo.clock, realNow)),

  availableOperations: (demo: Started, realNow: Date): ReadonlyArray<SessionOperation["kind"]> =>
    Session.availableOperations(demo.session, sessionTimeOf(demo.clock, realNow)),

  operate: (
    demo: Started,
    input: Readonly<{ kind: SessionOperation["kind"]; eventId: SessionEventId; realNow: Date }>,
  ): Result.Result<Started, OperationRejected> =>
    Result.pipe(
      Session.operate(demo.session, {
        kind: input.kind,
        id: input.eventId,
        at: sessionTimeOf(demo.clock, input.realNow),
      }),
      Result.map(({ session }): Started => ({ ...demo, session })),
    ),

  /** 記入を書く。書いた時点の状態に紐付き、自動終了までの時間も延びる。終了していれば書けない */
  write: (
    demo: Started,
    input: Readonly<{ id: JournalEntryId; body: JournalEntryBody; realNow: Date }>,
  ): Result.Result<Started, NoSessionInProgress> => {
    const now = sessionTimeOf(demo.clock, input.realNow);
    return Result.pipe(
      JournalEntry.write({
        id: input.id,
        body: input.body,
        tags: [],
        sessionId: demo.session.id,
        state: Session.stateAt(demo.session, now),
        now,
      }),
      Result.map((entry): Started => ({
        ...demo,
        session: {
          ...demo.session,
          journalEntryTimes: [...demo.session.journalEntryTimes, now],
        },
        entries: [entry, ...demo.entries],
      })),
    );
  },

  /** 実時間 `realNow` に効いているフェーズの進め方 */
  modeAt: (demo: Demo, realNow: Date): AdvanceMode => {
    switch (demo.kind) {
      case "NotStarted":
        return demo.mode;
      case "Started":
        return AdvanceModeChange.modeAt(
          demo.session.advanceModeChanges,
          sessionTimeOf(demo.clock, realNow),
        );
    }
  },

  /** 始める前に戻す。いま効いている進め方は持ち越す */
  reset: (demo: Demo, realNow: Date): Demo => Demo.initial(Demo.modeAt(demo, realNow)),
} as const;
