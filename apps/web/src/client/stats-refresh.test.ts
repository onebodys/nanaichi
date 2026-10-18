import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { SessionEventId } from "../domain/session-event.ts";
import { Session, SessionId } from "../domain/session.ts";
import { statsRefreshKeyOf } from "./stats-refresh.ts";
import type { TimerView } from "./use-session-timer.ts";

// 2026-10-14 9:00（日本時間）
const STARTED_AT = Date.UTC(2026, 9, 14, 0, 0, 0);
const at = (minutes: number) => new Date(STARTED_AT + minutes * 60_000);

const session = Session.start(
  v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000000"),
  v.parse(SessionEventId.schema, "00000000-0000-4000-8000-000000000001"),
  at(0),
  [],
);

const viewAt = (minutes: number): TimerView => {
  const state = Session.stateAt(session, at(minutes));
  return state.kind === "Ended"
    ? { kind: "Ended", session, state }
    : { kind: "InSession", session, state, operations: [] };
};

const keyAt = (minutes: number, view = viewAt(minutes)) =>
  statsRefreshKeyOf(view, at(minutes), "Asia/Tokyo");

describe("スタッツを読み込み直すきっかけ", () => {
  test("集中の途中では変わらず、集中を終えて完了セットが増えたときに変わる", () => {
    expect(keyAt(1)).toBe(keyAt(6));
    expect(keyAt(7)).not.toBe(keyAt(6));
  });

  test("セッションを始めた・終えたときに変わる", () => {
    expect(keyAt(1)).not.toBe(keyAt(1, { kind: "NoSession" }));
  });

  test("日付が変わったときに変わる", () => {
    const view: TimerView = { kind: "NoSession" };

    expect(statsRefreshKeyOf(view, at(0), "Asia/Tokyo")).not.toBe(
      statsRefreshKeyOf(view, at(15 * 60), "Asia/Tokyo"),
    );
  });
});
