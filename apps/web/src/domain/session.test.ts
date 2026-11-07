import * as v from "valibot";
import { goldenCases, settled } from "../testing/golden.ts";
import type { AdvanceModeChange } from "./advance-mode.ts";
import {
  SessionEventId,
  type RecordedSessionEvent,
  type SessionOperation,
} from "./session-event.ts";
import { Session, SessionId, SessionSnapshot } from "./session.ts";

const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
const at = (minutes: number, seconds = 0) =>
  new Date(STARTED_AT + minutes * 60_000 + seconds * 1000);

const sessionId = v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000000");
const eventId = (n: number) =>
  v.parse(SessionEventId.schema, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

const started: Session = {
  id: sessionId,
  events: [{ kind: "Start", id: eventId(0), at: at(0) }],
  journalEntryTimes: [],
  advanceModeChanges: [],
};

/** 開始のあとに、順に `[操作, 開始からの分]` を足したセッション */
const operated = (
  ...operations: ReadonlyArray<readonly [SessionOperation["kind"], number]>
): Session => ({
  ...started,
  events: [
    ...started.events,
    ...operations.map(([kind, minutes], i): RecordedSessionEvent<SessionOperation> => ({
      kind,
      id: eventId(i + 1),
      at: at(minutes),
    })),
  ],
});

goldenCases(
  "Session.start",
  (
    i: Readonly<{
      id: Session["id"];
      startEventId: ReturnType<typeof eventId>;
      now: Date;
      advanceModeChanges: ReadonlyArray<AdvanceModeChange>;
    }>,
  ) => Session.start(i.id, i.startEventId, i.now, i.advanceModeChanges),
  [
    {
      name: "開始すると開始の操作イベントだけを持つ",
      input: { id: sessionId, startEventId: eventId(0), now: at(0), advanceModeChanges: [] },
      expected: started,
    },
  ],
);

type AtInput = Readonly<{ session: Session; now: Date }>;

goldenCases("Session.stateAt", (i: AtInput) => Session.stateAt(i.session, i.now), [
  {
    name: "開始すると1ラウンド目の1セット目の集中になる",
    input: { session: started, now: at(0) },
    expected: {
      kind: "Focus",
      round: 1,
      setNumber: 1,
      completedSets: 0,
      remainingSeconds: 7 * 60,
      clock: { kind: "Running", endsAt: at(7) },
    },
  },
]);

goldenCases(
  "Session.operate",
  (i: Readonly<{ session: Session; operation: RecordedSessionEvent<SessionOperation> }>) =>
    settled(Session.operate(i.session, i.operation)),
  [
    {
      name: "その状態でできる操作なら、操作イベントを足した状態を返す",
      input: { session: started, operation: { kind: "Pause", id: eventId(1), at: at(2) } },
      expected: {
        kind: "Success",
        value: {
          session: operated(["Pause", 2]),
          state: {
            kind: "Focus",
            round: 1,
            setNumber: 1,
            completedSets: 0,
            remainingSeconds: 5 * 60,
            clock: { kind: "Paused", pausedAt: at(2) },
          },
        },
      },
    },
    {
      name: "その状態でできない操作なら OperationRejected を返す",
      input: { session: started, operation: { kind: "SkipBreak", id: eventId(1), at: at(2) } },
      expected: {
        kind: "Failure",
        error: { kind: "OperationRejected", operation: "SkipBreak", at: at(2), during: "Focus" },
      },
    },
    {
      name: "自動終了の時刻を過ぎてからの操作は、終了したセッションへの操作として受け付けない",
      input: { session: started, operation: { kind: "Pause", id: eventId(1), at: at(58) } },
      expected: {
        kind: "Failure",
        error: { kind: "OperationRejected", operation: "Pause", at: at(58), during: "Ended" },
      },
    },
  ],
);

goldenCases(
  "Session.autoEndDueAt",
  (i: Readonly<{ session: Session }>) => Session.autoEndDueAt(i.session),
  [
    {
      name: "開始したばかりなら、開始から2ラウンド分（58分）後",
      input: { session: started },
      expected: at(58),
    },
    {
      name: "最後の記入・操作から2ラウンド分後になる",
      input: {
        session: { ...operated(["Pause", 5]), journalEntryTimes: [at(3), at(9)] },
      },
      expected: at(9 + 58),
    },
  ],
);

goldenCases(
  "Session.availableOperations",
  (i: AtInput) => Session.availableOperations(i.session, i.now),
  [
    {
      name: "集中中は一時停止・中断・終了ができる",
      input: { session: started, now: at(3) },
      expected: ["Pause", "Abort", "End"],
    },
    {
      name: "一時停止中の集中は再開・中断・終了ができる",
      input: { session: operated(["Pause", 3]), now: at(4) },
      expected: ["Resume", "Abort", "End"],
    },
    {
      name: "ジャーナル中は中断できず、一時停止と終了ができる",
      input: { session: started, now: at(7, 30) },
      expected: ["Pause", "End"],
    },
    {
      name: "休憩中は一時停止・休憩スキップ・終了ができる",
      input: { session: started, now: at(25) },
      expected: ["Pause", "SkipBreak", "End"],
    },
    {
      name: "一時停止中の休憩は再開・休憩スキップ・終了ができる",
      input: { session: operated(["Pause", 25]), now: at(26) },
      expected: ["Resume", "SkipBreak", "End"],
    },
    {
      name: "中断して待機になったら、集中の再開始と終了ができる",
      input: { session: operated(["Abort", 3]), now: at(4) },
      expected: ["RestartFocus", "End"],
    },
    {
      name: "終了したセッションには、どの操作もできない",
      input: { session: operated(["End", 3]), now: at(4) },
      expected: [],
    },
    {
      name: "自動終了の時刻を過ぎたセッションには、どの操作もできない",
      input: { session: started, now: at(58) },
      expected: [],
    },
  ],
);

const snapshotAt = (minutes: number): SessionSnapshot => ({
  kind: "Session",
  serverTime: at(minutes),
  session: started,
  state: {
    kind: "Focus",
    round: 1,
    setNumber: 1,
    completedSets: 0,
    remainingSeconds: (7 - minutes) * 60,
    clock: { kind: "Running", endsAt: at(7) },
  },
});

goldenCases(
  "SessionSnapshot.isOlder",
  (i: Readonly<{ received: SessionSnapshot; current: SessionSnapshot }>) =>
    SessionSnapshot.isOlder(i.received, i.current),
  [
    {
      name: "届いたスナップショットのサーバーの時刻が手元より前なら、古いものとして捨てる",
      input: { received: snapshotAt(1), current: snapshotAt(2) },
      expected: true,
    },
    {
      name: "同じ時刻なら同じ変更なので、古いとはみなさない",
      input: { received: { kind: "NoSession", serverTime: at(2) }, current: snapshotAt(2) },
      expected: false,
    },
    {
      name: "手元より後の時刻なら、セッションなしに変わったものでも新しいものとして使う",
      input: { received: { kind: "NoSession", serverTime: at(3) }, current: snapshotAt(2) },
      expected: false,
    },
  ],
);
