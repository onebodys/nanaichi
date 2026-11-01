import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { AdvanceMode } from "../../domain/advance-mode.ts";
import { SessionEventId } from "../../domain/session-event.ts";
import { SessionId } from "../../domain/session.ts";
import { Demo } from "./demo-session.ts";
import { rhythmBeatsOf } from "./rhythm-score.ts";

const T0 = new Date("2026-10-21T09:00:00+09:00");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const start = (mode: AdvanceMode = AdvanceMode.default) =>
  Demo.start(Demo.initial(mode), {
    sessionId: v.parse(SessionId.schema, uuid(1)),
    eventId: v.parse(SessionEventId.schema, uuid(2)),
    realNow: T0,
    speed: 60,
  });

const beatsAt = (seconds: number, mode?: AdvanceMode) =>
  rhythmBeatsOf(Demo.stateAt(start(mode), at(seconds)));

describe("LP のリズムの帯", () => {
  test("集中の途中は、1つ目の拍がその割合まで進む", () => {
    expect(beatsAt(3.5)).toEqual([0.5, 0, 0, 0, 0, 0, 0]);
  });

  test("ジャーナルに入ると、集中の拍は終わり、ジャーナルの拍が進む", () => {
    expect(beatsAt(7.5)).toEqual([1, 0.5, 0, 0, 0, 0, 0]);
  });

  test("2セット目の集中では、1セット目の集中とジャーナルが終わっている", () => {
    expect(beatsAt(8)).toEqual([1, 1, 0, 0, 0, 0, 0]);
  });

  test("休憩では、3セットぶんの拍が終わり、最後の拍が進む", () => {
    const beats = beatsAt(26.5);
    expect(beats.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(beats[6]).toBeCloseTo(0.5);
  });

  test("切り替え待ちでは、終わったフェーズの拍までが終わっている", () => {
    const manual = { ...AdvanceMode.default, FocusToJournal: "Manual" } as const;
    expect(beatsAt(10, manual)).toEqual([1, 0, 0, 0, 0, 0, 0]);
  });
});
