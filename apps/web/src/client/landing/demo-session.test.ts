import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { AdvanceMode } from "../../domain/advance-mode.ts";
import { JournalEntryBody, JournalEntryId } from "../../domain/journal-entry.ts";
import { SessionEventId } from "../../domain/session-event.ts";
import { SessionId } from "../../domain/session.ts";
import { Demo } from "./demo-session.ts";

const T0 = new Date("2026-10-21T09:00:00+09:00");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let serial = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
const eventId = () => v.parse(SessionEventId.schema, uuid());
const entryId = () => v.parse(JournalEntryId.schema, uuid());
const body = (text: string) => v.parse(JournalEntryBody.schema, text);

const start = (speed: number, mode: AdvanceMode = AdvanceMode.default) =>
  Demo.start(Demo.initial(mode), {
    sessionId: v.parse(SessionId.schema, uuid()),
    eventId: eventId(),
    realNow: T0,
    speed,
  });

describe("LP で試せるタイマー", () => {
  test("開始すると1ラウンド目の1セット目の集中が7分から始まる", () => {
    const state = Demo.stateAt(start(1), T0);

    expect(state).toMatchObject({ kind: "Focus", round: 1, setNumber: 1, remainingSeconds: 420 });
  });

  test("実時間で動かすと、7分たったところでジャーナルに移る", () => {
    const demo = start(1);

    expect(Demo.stateAt(demo, at(419)).kind).toBe("Focus");
    expect(Demo.stateAt(demo, at(420))).toMatchObject({ kind: "Journal", round: 1, setNumber: 1 });
  });

  test("60倍速では、実時間の7秒でジャーナルに、29秒で次のラウンドの集中に移る", () => {
    const demo = start(60);

    expect(Demo.stateAt(demo, at(7)).kind).toBe("Journal");
    expect(Demo.stateAt(demo, at(26)).kind).toBe("Break");
    expect(Demo.stateAt(demo, at(29))).toMatchObject({ kind: "Focus", round: 2, setNumber: 1 });
  });

  test("ジャーナル中に書いた記入は、そのセットのジャーナルに紐付き、新しいものが先に並ぶ", () => {
    const written = Result.unwrap(
      Demo.write(start(60), { id: entryId(), body: body("前提を3つ書き出した"), realNow: at(3) }),
    );
    const demo = Result.unwrap(
      Demo.write(written, { id: entryId(), body: body("次は根拠を足す"), realNow: at(7.5) }),
    );

    expect(demo.entries.map((entry) => entry.writtenDuring)).toEqual([
      { kind: "Journal", round: 1, setNumber: 1 },
      { kind: "Focus", round: 1, setNumber: 1 },
    ]);
  });

  test("集中中に中断すると不成立セットになり待機に戻る", () => {
    const demo = Result.unwrap(
      Demo.operate(start(1), { kind: "Abort", eventId: eventId(), realNow: at(60) }),
    );

    expect(Demo.stateAt(demo, at(61))).toMatchObject({ kind: "Idle", round: 1, setNumber: 1 });
    expect(Demo.availableOperations(demo, at(61))).toContain("RestartFocus");
  });

  test("休憩中は中断できない", () => {
    const rejected = Demo.operate(start(60), {
      kind: "Abort",
      eventId: eventId(),
      realNow: at(27),
    });

    expect(Result.isFailure(rejected)).toBe(true);
  });

  test("終了するとセッションの外になり、記入は書けない", () => {
    const ended = Result.unwrap(
      Demo.operate(start(1), { kind: "End", eventId: eventId(), realNow: at(30) }),
    );

    const written = Demo.write(ended, { id: entryId(), body: body("書けない"), realNow: at(31) });

    expect(Demo.stateAt(ended, at(31)).kind).toBe("Ended");
    expect(Result.isFailure(written)).toBe(true);
  });

  test("始める前に集中 → ジャーナルを手動にすると、7分たったところで切り替え待ちで止まる", () => {
    const manual = { ...AdvanceMode.default, FocusToJournal: "Manual" } as const;
    const demo = start(1, manual);

    expect(Demo.stateAt(demo, at(600))).toMatchObject({
      kind: "AwaitingAdvance",
      finished: { kind: "Focus", round: 1, setNumber: 1 },
    });
  });

  test("始める前に戻しても、始めたときの進め方は持ち越す", () => {
    const manual = { ...AdvanceMode.default, BreakToFocus: "Manual" } as const;
    const demo = Demo.reset(start(1, manual), at(20));

    expect(demo).toEqual({ kind: "NotStarted", mode: manual });
  });
});
