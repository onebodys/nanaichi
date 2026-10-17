import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { schemaResult } from "./schema-result.ts";
import { SessionEventId } from "./session-event.ts";
import { Session, SessionId, SessionSnapshotJsonSchema, type SessionSnapshot } from "./session.ts";

const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
const at = (minutes: number) => new Date(STARTED_AT + minutes * 60_000);

const sessionId = v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000000");
const eventId = (n: number) =>
  v.parse(SessionEventId.schema, `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

const parseSnapshot = schemaResult(SessionSnapshotJsonSchema);

/** サーバーが応答するときと同じく JSON にする（Hono の `c.json` は `JSON.stringify`） */
const overTheWire = (snapshot: SessionSnapshot): unknown => JSON.parse(JSON.stringify(snapshot));

const session: Session = {
  id: sessionId,
  events: [
    { kind: "Start", id: eventId(0), at: at(0) },
    { kind: "Pause", id: eventId(1), at: at(2) },
    { kind: "Resume", id: eventId(2), at: at(3) },
  ],
  journalEntryTimes: [at(8)],
};

describe("API の応答のスナップショットを検証して戻す", () => {
  test("セッションなしのスナップショットを、サーバー時刻を Date に戻して受け取れる", () => {
    const snapshot: SessionSnapshot = { kind: "NoSession", serverTime: at(0) };

    expect(parseSnapshot(overTheWire(snapshot))).toEqual(Result.succeed(snapshot));
  });

  test.each([
    ["集中中", 1],
    ["一時停止中", 2.5],
    ["ジャーナル中", 8.5],
    ["休憩中", 26],
    ["自動終了後", 200],
  ])("%sのスナップショットを、操作イベントと状態ごと元のとおりに受け取れる", (_, minutes) => {
    const snapshot = Session.snapshot(session, at(minutes));

    expect(parseSnapshot(overTheWire(snapshot))).toEqual(Result.succeed(snapshot));
  });

  test("中断して待機になったスナップショットを受け取れる", () => {
    const aborted: Session = {
      ...session,
      events: [...session.events, { kind: "Abort", id: eventId(3), at: at(5) }],
    };
    const snapshot = Session.snapshot(aborted, at(6));

    expect(snapshot.kind === "Session" && snapshot.state.kind).toBe("Idle");
    expect(parseSnapshot(overTheWire(snapshot))).toEqual(Result.succeed(snapshot));
  });

  test("知らない種類のスナップショットは ValidationError になる", () => {
    const parsed = parseSnapshot({ kind: "Unknown", serverTime: at(0).toISOString() });

    expect(Result.isFailure(parsed) && parsed.error.kind).toBe("ValidationError");
  });

  test("時刻が ISO 8601 の文字列でなければ ValidationError になる", () => {
    const parsed = parseSnapshot({ kind: "NoSession", serverTime: STARTED_AT });

    expect(Result.isFailure(parsed)).toBe(true);
  });

  test("操作イベントが開始から始まっていなければ ValidationError になる", () => {
    const wire = overTheWire(Session.snapshot(session, at(1)));
    const broken = {
      ...(typeof wire === "object" ? wire : {}),
      session: { id: sessionId, events: [], journalEntryTimes: [] },
    };

    expect(Result.isFailure(parseSnapshot(broken))).toBe(true);
  });
});
