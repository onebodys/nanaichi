import * as v from "valibot";
import { goldenCases } from "../testing/golden.ts";
import { SessionEventId } from "./session-event.ts";
import { SessionSummary } from "./session-summary.ts";
import { type Session, SessionId } from "./session.ts";

const STARTED_AT = Date.UTC(2026, 9, 17, 4, 5, 0);
const at = (minutes: number) => new Date(STARTED_AT + minutes * 60_000);

const sessionId = v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000000");
const eventId = (n: number) =>
  v.parse(SessionEventId.schema, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

const sessionWith = (operations: Session["events"][number][]): Session => ({
  id: sessionId,
  events: [
    { kind: "Start", id: eventId(0), at: at(0) },
    ...operations.flatMap((operation) => (operation.kind === "Start" ? [] : [operation])),
  ],
  journalEntryTimes: [],
  advanceModeChanges: [],
});

goldenCases("SessionSummary.of", SessionSummary.of, [
  {
    // 1セット目を中断し、やり直した1セット目と2セット目を完了したあと、3セット目の集中の途中で終了する
    name: "始めた・終わった時刻、集中時間、完了セット、不成立セット、記入の数をまとめる",
    input: {
      session: sessionWith([
        { kind: "Abort", id: eventId(1), at: at(3) },
        { kind: "RestartFocus", id: eventId(2), at: at(4) },
        { kind: "End", id: eventId(3), at: at(22) },
      ]),
      ended: { kind: "Ended", endedAt: at(22), endedBy: "End", completedSets: 2 },
      now: at(23),
      entries: { kind: "Counted", count: 5 },
    },
    expected: {
      startedAt: at(0),
      endedAt: at(22),
      endedBy: "End",
      focusTimeMs: 14 * 60_000,
      completedSets: 2,
      abortedSets: 2,
      sets: [
        { kind: "AbortedSet", round: 1, setNumber: 1, at: at(3) },
        { kind: "CompletedSet", round: 1, setNumber: 1, at: at(11) },
        { kind: "CompletedSet", round: 1, setNumber: 2, at: at(19) },
        { kind: "AbortedSet", round: 1, setNumber: 3, at: at(22) },
      ],
      entries: { kind: "Counted", count: 5 },
    },
  },
  {
    // 開始の 2分後に一時停止したまま放置した。最後の操作（一時停止）の時刻で閉じる
    name: "自動終了したセッションは、最後の操作の時刻で閉じたまとめになる",
    input: {
      session: sessionWith([{ kind: "Pause", id: eventId(1), at: at(2) }]),
      ended: { kind: "Ended", endedAt: at(2), endedBy: "AutoEnd", completedSets: 0 },
      now: at(120),
      entries: { kind: "NotYetCounted" },
    },
    expected: {
      startedAt: at(0),
      endedAt: at(2),
      endedBy: "AutoEnd",
      focusTimeMs: 0,
      completedSets: 0,
      abortedSets: 1,
      sets: [{ kind: "AbortedSet", round: 1, setNumber: 1, at: at(2) }],
      entries: { kind: "NotYetCounted" },
    },
  },
]);
