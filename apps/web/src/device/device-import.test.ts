import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import type { Backend, BackendError } from "../domain/backend.ts";
import { SessionEventId } from "../domain/session-event.ts";
import { SessionId } from "../domain/session.ts";
import { createDeviceBackend } from "./device-backend.ts";
import { createDeviceImport, type DeviceImport } from "./device-import.ts";
import { MemoryStore, memoryVault } from "./vault.ts";

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const eventId = () => v.parse(SessionEventId.schema, crypto.randomUUID());
const newSessionId = () => v.parse(SessionId.schema, crypto.randomUUID());

const unwrap = async <T>(result: Promise<Result.Result<T, BackendError>>): Promise<T> => {
  const settled = await result;
  if (Result.isFailure(settled)) {
    throw new Error(`失敗した: ${JSON.stringify(settled.error)}`);
  }
  return settled.value;
};

const browser = () => {
  const store = MemoryStore.empty();
  const clock = { now: T0 };
  // タブごとに保存先の口を開く。同じ保存先を、別の読み込みの手元の記録で読む
  const deps = {
    exclusive: <T>(section: () => Promise<T>) => section(),
    clock: () => new Date(clock.now),
    persist: () => undefined,
  };
  const tab: Backend = createDeviceBackend({
    ...deps,
    vault: memoryVault(store),
    channel: { post: () => undefined, listen: () => () => undefined },
    newSessionId,
  });
  const importer: DeviceImport = createDeviceImport({ ...deps, vault: memoryVault(store) });
  return { store, clock, tab, importer };
};

/** 始めて、書いて、終える。終えたセッションの ID を返す */
const recordSession = async (tab: Backend, clock: { now: number }) => {
  await unwrap(tab.startSession(eventId()));
  clock.now += MINUTE;
  await unwrap(tab.operateSession(eventId(), "End"));
  clock.now += MINUTE;
  const page = await unwrap(tab.getTimeline());
  const [latest] = page.sessions;
  if (latest === undefined) {
    throw new Error("セッションが記録されているはず");
  }
  return latest.session.id;
};

describe("この端末の記録の取り込みの口", () => {
  test("取り込めるのは閉じたセッションだけで、開いたままのセッションがあれば残っていると返す", async () => {
    const { tab, clock, importer } = browser();
    const first = await recordSession(tab, clock);
    const second = await recordSession(tab, clock);
    await unwrap(tab.startSession(eventId()));

    const importable = await unwrap(importer.load());

    expect(importable.sessions.map(({ id }) => id)).toEqual([first, second]);
    expect(importable.open).toEqual({ kind: "OpenSessionLeft" });
  });

  test("自動終了の時刻を過ぎて開いていたセッションは、閉じてから取り込める記録に入る", async () => {
    const { tab, clock, importer } = browser();
    await unwrap(tab.startSession(eventId()));
    clock.now += DAY;

    const importable = await unwrap(importer.load());

    expect(importable.sessions).toHaveLength(1);
    expect(importable.sessions[0]?.endedBy).toBe("AutoEnd");
    expect(importable.open).toEqual({ kind: "NoOpenSession" });
    expect((await unwrap(tab.getCurrentSession())).kind).toBe("NoSession");
  });

  test("指定した閉じたセッションだけを消し、この端末の記録先のタブも消えたものを読む", async () => {
    const { tab, clock, importer, store } = browser();
    const first = await recordSession(tab, clock);
    const second = await recordSession(tab, clock);

    await unwrap(importer.removeClosedSessions([first]));

    expect([...store.sessions.keys()]).toEqual([second]);
    expect((await unwrap(importer.load())).sessions.map(({ id }) => id)).toEqual([second]);
    const page = await unwrap(tab.getTimeline());
    expect(page.sessions.map(({ session }) => session.id)).toEqual([second]);
  });

  test("開いているセッションやない ID を指定しても何も消さず、失敗もしない", async () => {
    const { tab, clock, importer, store } = browser();
    const closed = await recordSession(tab, clock);
    await unwrap(tab.startSession(eventId()));
    const open = (await unwrap(tab.getTimeline())).sessions[0]?.session.id;
    if (open === undefined) {
      throw new Error("開いているセッションがあるはず");
    }
    const before = { meta: store.meta, sessions: [...store.sessions.keys()] };

    expect(await importer.removeClosedSessions([open, newSessionId()])).toEqual(
      Result.succeed(undefined),
    );
    expect({ meta: store.meta, sessions: [...store.sessions.keys()] }).toEqual(before);

    await unwrap(importer.removeClosedSessions([closed]));
    await unwrap(importer.removeClosedSessions([closed]));
    expect([...store.sessions.keys()]).toEqual([open]);
  });
});
