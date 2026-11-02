import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { JournalEntryId } from "../domain/journal-entry.ts";
import { SessionId } from "../domain/session.ts";
import { storeContract } from "../testing/store-contract.ts";
import { editJournalEntry } from "../workflows/edit-journal-entry.ts";
import { operateSession } from "../workflows/operate-session.ts";
import { startSession } from "../workflows/start-session.ts";
import { writeJournalEntry } from "../workflows/write-journal-entry.ts";
import {
  changedSessionRecords,
  deviceNow,
  DeviceRecords,
  recordsDeps,
  type Draft,
} from "./records.ts";

storeContract(async (scene) => {
  scene(recordsDeps({ base: DeviceRecords.empty, current: DeviceRecords.empty }));
});

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const newSessionId = () => v.parse(SessionId.schema, crypto.randomUUID());
const entryId = () => v.parse(JournalEntryId.schema, crypto.randomUUID());

describe("端末の時計", () => {
  test("時計が記録済みの時刻より前に戻っても、再開・終了できる", () => {
    const draft: Draft = { base: DeviceRecords.empty, current: DeviceRecords.empty };
    const deps = recordsDeps(draft);
    let clock = at(0);
    const now = () => deviceNow(() => clock, draft.current);

    startSession(deps)({ id: crypto.randomUUID() }, now(), newSessionId());
    clock = at(5);
    expect(
      Result.isSuccess(operateSession(deps)({ id: crypto.randomUUID(), kind: "Pause" }, now())),
    ).toBe(true);
    clock = at(3);

    expect(() =>
      operateSession(deps)({ id: crypto.randomUUID(), kind: "Resume" }, clock),
    ).toThrow();
    const resumed = operateSession(deps)({ id: crypto.randomUUID(), kind: "Resume" }, now());
    const ended = operateSession(deps)({ id: crypto.randomUUID(), kind: "End" }, now());

    expect(Result.isSuccess(resumed)).toBe(true);
    expect(ended).toMatchObject({
      type: "Success",
      value: { state: { kind: "Ended", endedBy: "End", endedAt: at(5) } },
    });
  });

  test("時計が戻っていなければ、端末の時計の時刻をそのまま使う", () => {
    const draft: Draft = { base: DeviceRecords.empty, current: DeviceRecords.empty };
    startSession(recordsDeps(draft))({ id: crypto.randomUUID() }, at(0), newSessionId());

    expect(deviceNow(() => at(7), draft.current)).toEqual(at(7));
    expect(deviceNow(() => at(-1), DeviceRecords.empty)).toEqual(at(-1));
  });
});

describe("書き換えたセッションだけが変わる", () => {
  test("別のセッションに書いても、ほかのセッションは同じオブジェクトのまま残る", () => {
    const draft: Draft = { base: DeviceRecords.empty, current: DeviceRecords.empty };
    const deps = recordsDeps(draft);
    const written = Array.from({ length: 2 }, (_, i) => {
      startSession(deps)({ id: crypto.randomUUID() }, at(i * 10), newSessionId());
      const id = entryId();
      writeJournalEntry(deps)({ id, body: `${i + 1}つ目` }, at(i * 10 + 1));
      operateSession(deps)({ id: crypto.randomUUID(), kind: "End" }, at(i * 10 + 2));
      return id;
    });
    startSession(deps)({ id: crypto.randomUUID() }, at(30), newSessionId());
    const loaded = draft.current;
    const second = { base: loaded, current: loaded };

    writeJournalEntry(recordsDeps(second))({ id: entryId(), body: "進行中" }, at(31));
    second.current.closed.forEach((session, i) => expect(session).toBe(loaded.closed[i]));
    expect(changedSessionRecords(loaded, second.current).map((r) => r.kind)).toEqual(["Open"]);

    const third = { base: loaded, current: loaded };
    editJournalEntry(recordsDeps(third))(written[0], { body: "直した", tags: [] }, at(32));
    expect(third.current.closed[1]).toBe(loaded.closed[1]);
    expect(third.current.open).toBe(loaded.open);
    expect(changedSessionRecords(loaded, third.current).map((r) => r.session.id)).toEqual([
      loaded.closed[0]?.id,
    ]);
  });
});
