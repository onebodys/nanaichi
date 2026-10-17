import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { JsonDateSchema } from "./json-date.ts";
import {
  RecordedSessionEventsJsonSchema,
  SessionOperationKind,
  type RecordedSessionEvent,
  type RecordedSessionEvents,
  type SessionEventId,
  type SessionOperation,
} from "./session-event.ts";
import {
  autoEndDueAt,
  deriveTimerState,
  TimerStateJsonSchema,
  type Ended,
  type OperationRejected,
  type TimerState,
} from "./timer-state.ts";

const SessionIdSchema = v.pipe(v.string(), v.uuid(), v.brand("SessionId"));
export type SessionId = v.InferOutput<typeof SessionIdSchema>;

export const SessionId = {
  schema: SessionIdSchema,
} as const;

/**
 * 記録されているセッション（GLOSSARY の「セッション」）。
 *
 * 終了したかどうかは持たない。自動終了は時刻から計算するので、記録の上でまだ閉じていなくても
 * 状態は終了でありうる。状態はいつも `Session.stateAt` で操作イベントと時刻から計算する（ADR 0003）。
 *
 * - `journalEntryTimes`: このセッションのジャーナル記入の時刻。自動終了の判断にだけ使う
 */
export type Session = Readonly<{
  id: SessionId;
  events: RecordedSessionEvents;
  journalEntryTimes: ReadonlyArray<Date>;
}>;

/**
 * ある時刻のセッションの様子。API の応答にそのまま使う。
 *
 * クライアントは `events` と `journalEntryTimes` から自分で状態を計算し直し、
 * `serverTime` との差で端末の時計のずれを補正する（ADR 0003）。
 */
export type SessionSnapshot =
  | Readonly<{ kind: "NoSession"; serverTime: Date }>
  | Readonly<{ kind: "Session"; serverTime: Date; session: Session; state: TimerState }>;

/**
 * JSON にしたスナップショット（`GET /api/session/current` などの応答）を検証して戻す。
 *
 * サーバーは `SessionSnapshot` をそのまま JSON にして返し、クライアントはこれで検証してから使う
 * （AGENTS.md §5）。時刻は ISO 8601 の文字列から `Date` に戻る。
 */
export const SessionSnapshotJsonSchema: v.GenericSchema<unknown, SessionSnapshot> = v.variant(
  "kind",
  [
    v.object({ kind: v.literal("NoSession"), serverTime: JsonDateSchema }),
    v.object({
      kind: v.literal("Session"),
      serverTime: JsonDateSchema,
      session: v.object({
        id: SessionIdSchema,
        events: RecordedSessionEventsJsonSchema,
        journalEntryTimes: v.array(JsonDateSchema),
      }),
      state: TimerStateJsonSchema,
    }),
  ],
);

export const Session = {
  /** セッションを始める。1ラウンド目の1セット目の集中がすぐに始まる */
  start: (id: SessionId, startEventId: SessionEventId, now: Date): Session => ({
    id,
    events: [{ kind: "Start", id: startEventId, at: now }],
    journalEntryTimes: [],
  }),

  /**
   * 時刻 `now` のタイマーの状態。
   *
   * 記録済みの操作イベントは受け付けたときに検査しているので、計算できないのは
   * 記録が壊れているときだけ。想定内の失敗ではなく不変条件違反として例外にする。
   */
  stateAt: (session: Session, now: Date): TimerState => {
    const derived = deriveTimerState(session.events, now, session.journalEntryTimes);
    if (Result.isFailure(derived)) {
      throw new Error(`記録済みの操作イベントから状態を計算できない: ${derived.error.kind}`);
    }
    return derived.value;
  },

  /**
   * セッションに操作を加える。その時点の状態でできない操作なら `OperationRejected` を返す。
   *
   * 受け付けてよいかは、記録済みのイベントに足して計算し直せば判断できる（`deriveTimerState`）。
   */
  operate: (
    session: Session,
    operation: RecordedSessionEvent<SessionOperation>,
  ): Result.Result<Readonly<{ session: Session; state: TimerState }>, OperationRejected> => {
    const operated: Session = { ...session, events: [...session.events, operation] };
    const derived = deriveTimerState(operated.events, operation.at, operated.journalEntryTimes);
    if (Result.isSuccess(derived)) {
      return Result.succeed({ session: operated, state: derived.value });
    }
    if (derived.error.kind === "OperationRejected") {
      return Result.fail(derived.error);
    }
    // 操作の時刻は記録済みのどのイベントより後なので、時刻の順が崩れるのは呼び出し側の誤り
    throw new Error(`操作イベントの時刻が記録済みのイベントより前になっている`);
  },

  /**
   * 時刻 `now` にできる操作。画面はこれで、押せるボタンだけを出す。
   *
   * できるかどうかの規則を二重に持たないよう、記録済みのイベントに足して計算し直せるかで判断する
   * （`operate` と同じ判断）。終了していれば、どの操作もできない。
   */
  availableOperations: (session: Session, now: Date): ReadonlyArray<SessionOperation["kind"]> =>
    SessionOperationKind.schema.options.filter((kind) =>
      Result.isSuccess(
        deriveTimerState([...session.events, { kind, at: now }], now, session.journalEntryTimes),
      ),
    ),

  /** 記入も操作もないまま過ぎれば自動終了する時刻 */
  autoEndDueAt: (session: Session): Date => autoEndDueAt(session.events, session.journalEntryTimes),

  snapshot: (session: Session, now: Date): SessionSnapshot => ({
    kind: "Session",
    serverTime: now,
    session,
    state: Session.stateAt(session, now),
  }),
} as const;

// ---------------------------------------------------------------------------
// ワークフローが使う読み書きの契約（kamae: 概念の隣に置き、1つの契約に1つの操作）
// ---------------------------------------------------------------------------

/** 記録の上でまだ閉じていないセッション。同時に持てるセッションは1つまでなので高々1つ */
export type FindOpenSession = () => Session | undefined;

/** 操作イベントの ID から、そのイベントを含むセッションを探す（二重送信の判定に使う） */
export type FindSessionByEventId = (eventId: SessionEventId) => Session | undefined;

/** 開始したばかりのセッションを、開始の操作イベントとともに記録する */
export type SaveStartedSession = (session: Session) => void;

/** 受け付けた操作イベントを記録する */
export type AppendSessionOperation = (
  sessionId: SessionId,
  operation: RecordedSessionEvent<SessionOperation>,
) => void;

/** 終了したセッションを閉じる。閉じたセッションは現在のセッションではなくなる */
export type CloseSession = (sessionId: SessionId, ended: Ended) => void;
