import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import type { Backend, BackendError, SyncHandlers } from "../domain/backend.ts";
import { JournalEntryId } from "../domain/journal-entry.ts";
import { SessionEventId } from "../domain/session-event.ts";
import { SessionId } from "../domain/session.ts";
import type { SyncMessage } from "../domain/sync-message.ts";
import { createDeviceBackend, type SyncChannel } from "./device-backend.ts";
import { MemoryStore, memoryVault } from "./vault.ts";

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const eventId = () => v.parse(SessionEventId.schema, crypto.randomUUID());
const entryId = () => v.parse(JournalEntryId.schema, crypto.randomUUID());
const newSessionId = () => v.parse(SessionId.schema, crypto.randomUUID());

/** `navigator.locks.request` と同じく、前の区間が終わってから次の区間を始める */
const serialLock = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(section: () => Promise<T>): Promise<T> => {
    const run = tail.then(section);
    tail = run.catch(() => undefined);
    return run;
  };
};

/** BroadcastChannel と同じく、送ったタブ以外のすべてのタブに届ける */
const channelHub = () => {
  const listeners = new Set<Readonly<{ tab: object; onData: (data: unknown) => void }>>();
  return (): SyncChannel => {
    const tab = {};
    return {
      post: (data) =>
        listeners.forEach((listener) => listener.tab !== tab && listener.onData(data)),
      listen: (onData) => {
        const listener = { tab, onData };
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  };
};

/** 1つの保存先を共有するブラウザ。`openTab` でタブを開く */
const browser = () => {
  const store = MemoryStore.empty();
  const exclusive = serialLock();
  const channel = channelHub();
  const clock = { now: T0 };
  const persistRequests = { count: 0 };
  const openTab = (overrides: Readonly<{ newSessionId?: () => SessionId }> = {}): Backend =>
    createDeviceBackend({
      vault: memoryVault(store),
      exclusive,
      channel: channel(),
      clock: () => new Date(clock.now),
      newSessionId: overrides.newSessionId ?? newSessionId,
      persist: () => {
        persistRequests.count += 1;
      },
    });
  return { store, clock, persistRequests, openTab };
};

const received = (tab: Backend) => {
  const messages: Array<SyncMessage> = [];
  let connected = 0;
  const handlers: SyncHandlers = {
    onConnected: () => {
      connected += 1;
    },
    onMessage: (message) => messages.push(message),
  };
  const connection = tab.subscribe(handlers);
  return { messages, connection, connectedCount: () => connected };
};

const failed = (error: BackendError) => Result.fail(error);

const unwrap = async <T>(result: Result.ResultAsync<T, BackendError>): Promise<T> => {
  const settled = await result;
  if (Result.isFailure(settled)) {
    throw new Error(`失敗した: ${JSON.stringify(settled.error)}`);
  }
  return settled.value;
};

const snapshotKind = async (tab: Backend) => (await unwrap(tab.getCurrentSession())).kind;

describe("この端末の記録先", () => {
  test("開始すると記録され、別のタブが書いた変更は次の呼び出しで読み直す", async () => {
    const { openTab } = browser();
    const tabA = openTab();
    const tabB = openTab();
    expect(await snapshotKind(tabB)).toBe("NoSession");

    await unwrap(tabA.startSession(eventId()));

    expect(await snapshotKind(tabB)).toBe("Session");
    const id = entryId();
    await unwrap(tabB.writeJournalEntry(id, "読書をした", []));
    const page = await unwrap(tabA.getTimeline());
    expect(page.sessions.flatMap(({ entries }) => entries.map((entry) => entry.id))).toEqual([id]);
  });

  test("2つのタブで同時に開始してもセッションは1つ", async () => {
    const { openTab } = browser();
    const results = await Promise.all([
      openTab().startSession(eventId()),
      openTab().startSession(eventId()),
    ]);

    expect(results.filter(Result.isSuccess)).toHaveLength(1);
    expect(results.filter(Result.isFailure)).toEqual([
      failed({ kind: "Rejected", code: "SESSION_ALREADY_IN_PROGRESS" }),
    ]);
  });

  test("書いたタブにも同期メッセージが届き、別のタブにも届く", async () => {
    const { openTab } = browser();
    const tabA = openTab();
    const tabB = openTab();
    const inA = received(tabA);
    const inB = received(tabB);

    const snapshot = await unwrap(tabA.startSession(eventId()));

    expect(inA.messages).toEqual([{ kind: "SessionChanged", snapshot }]);
    expect(inB.messages).toEqual([{ kind: "SessionChanged", snapshot }]);
  });

  test("受け取り始めたあとで1回だけ繋がったと知らせ、閉じたあとは何も届かない", async () => {
    const { openTab } = browser();
    const tabA = openTab();
    const inB = received(openTab());
    expect(inB.connectedCount()).toBe(0);

    await Promise.resolve();
    expect(inB.connectedCount()).toBe(1);

    inB.connection.close();
    await unwrap(tabA.startSession(eventId()));
    expect(inB.messages).toEqual([]);
  });

  test("想定内の失敗は Rejected で返し、そのとき確定した自動終了は保存する", async () => {
    const { openTab, clock, store } = browser();
    const tab = openTab();
    await unwrap(tab.startSession(eventId()));
    const revision = JSON.stringify(store.meta);
    clock.now += DAY;

    expect(await tab.operateSession(eventId(), "Pause")).toEqual(
      failed({ kind: "Rejected", code: "NO_SESSION_IN_PROGRESS" }),
    );
    expect(JSON.stringify(store.meta)).not.toBe(revision);
    expect([...store.sessions.values()].join("")).toContain('"Closed"');
  });

  test("例外が出たら何も保存しない", async () => {
    const { openTab, clock, store } = browser();
    await unwrap(openTab().startSession(eventId()));
    const before = { meta: store.meta, sessions: [...store.sessions.values()] };
    // 自動終了の時刻を過ぎてから開始する。自動終了で閉じたあと、開始の途中で例外が出る
    clock.now += DAY;
    const tab = openTab({
      newSessionId: () => {
        throw new Error("ID を作れなかった");
      },
    });
    const inTab = received(tab);

    expect(await tab.startSession(eventId())).toEqual(failed({ kind: "Broken" }));
    expect({ meta: store.meta, sessions: [...store.sessions.values()] }).toEqual(before);
    expect(inTab.messages).toEqual([]);
  });

  test("読めない記録は上書きせず退避する", async () => {
    const { openTab, store } = browser();
    await unwrap(openTab().startSession(eventId()));
    const [id] = store.sessions.keys();
    if (id === undefined) {
      throw new Error("セッションが保存されているはず");
    }
    store.sessions.set(id, "{壊れた記録");
    const before = { meta: store.meta, sessions: [...store.sessions.values()] };

    const tab = openTab();
    expect(await tab.getCurrentSession()).toEqual(failed({ kind: "Broken" }));
    expect(await tab.startSession(eventId())).toEqual(failed({ kind: "Broken" }));
    expect(await openTab().deleteJournalEntry(entryId())).toEqual(failed({ kind: "Broken" }));

    expect({ meta: store.meta, sessions: [...store.sessions.values()] }).toEqual(before);
    expect([...store.unreadable.values()]).toEqual([
      { meta: before.meta, sessions: before.sessions },
    ]);
  });

  test("新しい版の記録は読むだけで書かない", async () => {
    const { openTab, store } = browser();
    store.meta = { revision: 7, changed: [], records: JSON.stringify({ version: 2 }) };
    const before = structuredClone(store.meta);
    const tab = openTab();

    const newerFormat = failed({ kind: "StorageFailed", reason: "NewerFormat" });
    expect(await tab.getCurrentSession()).toEqual(newerFormat);
    expect(await tab.startSession(eventId())).toEqual(newerFormat);

    expect(store.meta).toEqual(before);
    expect(store.sessions.size).toBe(0);
    expect([...store.unreadable.keys()]).toEqual(["unreadable-7"]);
  });

  test("保存先がいっぱいなら StorageFailed で、同期メッセージも送らない", async () => {
    const { openTab, store } = browser();
    const tab = openTab();
    const inTab = received(tab);
    store.failWrites = new DOMException("いっぱい", "QuotaExceededError");
    const id = eventId();

    expect(await tab.startSession(id)).toEqual(
      failed({ kind: "StorageFailed", reason: "QuotaExceeded" }),
    );
    expect(inTab.messages).toEqual([]);
    expect(await snapshotKind(tab)).toBe("NoSession");

    store.failWrites = undefined;
    await unwrap(tab.startSession(id));
    expect(await snapshotKind(openTab())).toBe("Session");
  });

  test("時計が戻っても操作できる", async () => {
    const { openTab, clock } = browser();
    const tab = openTab();
    clock.now += 10 * MINUTE;
    await unwrap(tab.startSession(eventId()));
    clock.now -= 10 * MINUTE;

    const paused = await unwrap(tab.operateSession(eventId(), "Pause"));
    expect(paused.kind === "Session" && paused.state.kind).toBe("Focus");
    expect(paused.serverTime).toEqual(new Date(T0 + 10 * MINUTE));
  });

  test("最初に書いたときだけ、保存した記録を消さないようブラウザに求める", async () => {
    const { openTab, persistRequests } = browser();
    const tab = openTab();
    await unwrap(tab.getCurrentSession());
    await unwrap(tab.getAdvanceMode());
    expect(persistRequests.count).toBe(0);

    await unwrap(tab.startSession(eventId()));
    await unwrap(tab.operateSession(eventId(), "Pause"));
    expect(persistRequests.count).toBe(1);
  });
});
