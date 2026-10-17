import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { SessionEventId, type SessionOperation } from "./session-event.ts";
import { Session, SessionId } from "./session.ts";

const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
const at = (minutes: number, seconds = 0) =>
  new Date(STARTED_AT + minutes * 60_000 + seconds * 1000);

const sessionId = v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000000");
const eventId = (n: number) =>
  v.parse(SessionEventId.schema, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

const started = Session.start(sessionId, eventId(0), at(0));

describe("セッションの開始", () => {
  test("開始すると開始の操作イベントだけを持ち、1ラウンド目の1セット目の集中になる", () => {
    expect(started.events).toEqual([{ kind: "Start", id: eventId(0), at: at(0) }]);
    expect(Session.stateAt(started, at(0))).toMatchObject({
      kind: "Focus",
      round: 1,
      setNumber: 1,
    });
  });
});

describe("セッションへの操作", () => {
  test("その状態でできる操作なら、操作イベントを足した状態を返す", () => {
    const operated = Session.operate(started, { kind: "Pause", id: eventId(1), at: at(2) });

    expect(Result.isSuccess(operated) && operated.value.state).toMatchObject({
      kind: "Focus",
      clock: { kind: "Paused", pausedAt: at(2) },
    });
  });

  test("その状態でできない操作なら OperationRejected を返す", () => {
    const operated = Session.operate(started, { kind: "SkipBreak", id: eventId(1), at: at(2) });

    expect(Result.isFailure(operated) && operated.error).toMatchObject({
      kind: "OperationRejected",
      operation: "SkipBreak",
      during: "Focus",
    });
  });

  test("自動終了の時刻を過ぎてからの操作は、終了したセッションへの操作として受け付けない", () => {
    const operated = Session.operate(started, { kind: "Pause", id: eventId(1), at: at(58) });

    expect(Result.isFailure(operated) && operated.error).toMatchObject({ during: "Ended" });
  });
});

describe("自動終了の時刻", () => {
  test("開始したばかりなら、開始から2ラウンド分（58分）後", () => {
    expect(Session.autoEndDueAt(started)).toEqual(at(58));
  });

  test("最後の記入・操作から2ラウンド分後になる", () => {
    const session: Session = {
      ...started,
      events: [...started.events, { kind: "Pause", id: eventId(1), at: at(5) }],
      journalEntryTimes: [at(3), at(9)],
    };

    expect(Session.autoEndDueAt(session)).toEqual(at(9 + 58));
  });
});

describe("その時点でできる操作", () => {
  const operated = (
    ...operations: ReadonlyArray<readonly [SessionOperation["kind"], number]>
  ): Session =>
    operations.reduce<Session>((session, [kind, minutes], i) => {
      const result = Session.operate(session, { kind, id: eventId(i + 1), at: at(minutes) });
      if (Result.isFailure(result)) {
        throw new Error(`操作を受け付けなかった: ${kind}`);
      }
      return result.value.session;
    }, started);

  test("集中中は一時停止・中断・終了ができる", () => {
    expect(Session.availableOperations(started, at(3))).toEqual(["Pause", "Abort", "End"]);
  });

  test("一時停止中の集中は再開・中断・終了ができる", () => {
    expect(Session.availableOperations(operated(["Pause", 3]), at(4))).toEqual([
      "Resume",
      "Abort",
      "End",
    ]);
  });

  test("ジャーナル中は中断できず、一時停止と終了ができる", () => {
    expect(Session.availableOperations(started, at(7, 30))).toEqual(["Pause", "End"]);
  });

  test("休憩中は一時停止・休憩スキップ・終了ができる", () => {
    expect(Session.availableOperations(started, at(25))).toEqual(["Pause", "SkipBreak", "End"]);
  });

  test("一時停止中の休憩は再開・休憩スキップ・終了ができる", () => {
    expect(Session.availableOperations(operated(["Pause", 25]), at(26))).toEqual([
      "Resume",
      "SkipBreak",
      "End",
    ]);
  });

  test("中断して待機になったら、集中の再開始と終了ができる", () => {
    expect(Session.availableOperations(operated(["Abort", 3]), at(4))).toEqual([
      "RestartFocus",
      "End",
    ]);
  });

  test("終了したセッションには、どの操作もできない", () => {
    expect(Session.availableOperations(operated(["End", 3]), at(4))).toEqual([]);
  });

  test("自動終了の時刻を過ぎたセッションには、どの操作もできない", () => {
    expect(Session.availableOperations(started, at(58))).toEqual([]);
  });
});
