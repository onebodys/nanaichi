import { Result } from "@praha/byethrow";
import { IDBFactory } from "fake-indexeddb";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { SessionId } from "../domain/session.ts";
import { operateSession } from "../workflows/operate-session.ts";
import { startSession } from "../workflows/start-session.ts";
import { writeJournalEntry } from "../workflows/write-journal-entry.ts";
import { DeviceRecords, recordsDeps, sessionRecordsOf, type Draft } from "./records.ts";
import { encodeMetaRecord, encodeSessionRecord } from "./records-json.ts";
import { indexedDbVault, VaultContent, type Vault } from "./vault.ts";

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const newSessionId = () => v.parse(SessionId.schema, crypto.randomUUID());

const changed = (records: DeviceRecords, change: (draft: Draft) => void): DeviceRecords => {
  const draft: Draft = { base: records, current: records };
  change(draft);
  return draft.current;
};

const started = (records: DeviceRecords, minute: number) =>
  changed(records, (draft) => {
    startSession(recordsDeps(draft))({ id: crypto.randomUUID() }, at(minute), newSessionId());
  });

const ended = (records: DeviceRecords, minute: number) =>
  changed(records, (draft) => {
    operateSession(recordsDeps(draft))({ id: crypto.randomUUID(), kind: "End" }, at(minute));
  });

const written = (records: DeviceRecords, minute: number) =>
  changed(records, (draft) => {
    writeJournalEntry(recordsDeps(draft))(
      { id: crypto.randomUUID(), body: "メモ", tags: [] },
      at(minute),
    );
  });

const unwrap = async <T>(result: Result.ResultAsync<T, unknown>): Promise<T> => {
  const settled = await result;
  if (Result.isFailure(settled)) {
    throw new Error(`失敗した: ${JSON.stringify(settled.error)}`);
  }
  return settled.value;
};

const encoded = ({ revision, records }: VaultContent) => ({
  revision,
  meta: encodeMetaRecord(records),
  sessions: sessionRecordsOf(records).map(encodeSessionRecord),
});

const commit = (vault: Vault, previous: VaultContent, records: DeviceRecords) =>
  unwrap(vault.commit(previous, records));

const database = (factory: IDBFactory, version = 1, upgrade?: (db: IDBDatabase) => void) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("nanaichi-device", version);
    request.addEventListener("upgradeneeded", () => upgrade?.(request.result));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

const rawGet = async (factory: IDBFactory, store: string, key: string): Promise<unknown> => {
  const db = await database(factory);
  const request = db.transaction(store, "readonly").objectStore(store).get(key);
  return new Promise((resolve) => {
    request.addEventListener("success", () => {
      db.close();
      resolve(request.result);
    });
  });
};

const rawPut = async (factory: IDBFactory, key: string, value: unknown): Promise<void> => {
  const db = await database(factory);
  const transaction = db.transaction("records", "readwrite");
  transaction.objectStore("records").put(value, key);
  return new Promise((resolve) => {
    transaction.addEventListener("complete", () => {
      db.close();
      resolve();
    });
  });
};

const MetaShape = v.object({ revision: v.number(), changed: v.array(v.string()) });

const metaOf = async (factory: IDBFactory) =>
  v.parse(MetaShape, await rawGet(factory, "records", "meta"));

const twoSessions = () => started(ended(started(DeviceRecords.empty, 0), 30), 60);

const openIdOf = (records: DeviceRecords): SessionId => {
  if (records.open.kind !== "Open") {
    throw new Error("開いているセッションがあるはず");
  }
  return records.open.session.id;
};

const closedIdOf = (records: DeviceRecords): SessionId => {
  const [first] = records.closed;
  if (first === undefined) {
    throw new Error("閉じたセッションがあるはず");
  }
  return first.id;
};

describe("この端末の保存先（IndexedDB）", () => {
  test("1つのセッションだけが変われば、そのセッションと meta だけを書く", async () => {
    const factory = new IDBFactory();
    const vault = indexedDbVault(factory);
    const first = await commit(vault, VaultContent.empty, twoSessions());
    const closedId = closedIdOf(first.records);
    const openId = openIdOf(first.records);

    const closedKey = `session:${closedId}`;
    const respaced = JSON.stringify(
      JSON.parse(v.parse(v.string(), await rawGet(factory, "records", closedKey))),
      null,
      1,
    );
    await rawPut(factory, closedKey, respaced);

    const second = await commit(vault, first, written(first.records, 61));

    expect(await rawGet(factory, "records", closedKey)).toBe(respaced);
    expect(await metaOf(factory)).toEqual({ revision: 2, changed: [openId] });
    const reloaded = await unwrap(indexedDbVault(factory).load(VaultContent.empty));
    expect(encoded(reloaded)).toEqual(encoded(second));
  });

  test("書き込みのトランザクションが取り消されたら、前の記録のまま", async () => {
    const factory = new IDBFactory();
    const vault = indexedDbVault(factory);
    const first = await commit(vault, VaultContent.empty, started(DeviceRecords.empty, 0));

    const other = started(DeviceRecords.empty, 10);
    await expect(vault.commit(VaultContent.empty, other)).rejects.toThrow();

    expect(await rawGet(factory, "records", `session:${openIdOf(other)}`)).toBeUndefined();
    expect((await metaOf(factory)).revision).toBe(1);
    expect(encoded(await unwrap(indexedDbVault(factory).load(VaultContent.empty)))).toEqual(
      encoded(first),
    );
  });

  test("別のタブが書いた変更を読み直す。版が2つ以上進んでいれば全部を読み直す", async () => {
    const factory = new IDBFactory();
    const tabA = indexedDbVault(factory);
    const tabB = indexedDbVault(factory);

    const first = await commit(tabA, VaultContent.empty, started(DeviceRecords.empty, 0));
    const seen = await unwrap(tabB.load(VaultContent.empty));
    expect(encoded(seen)).toEqual(encoded(first));

    const second = await commit(tabA, first, written(first.records, 1));
    expect(encoded(await unwrap(tabB.load(seen)))).toEqual(encoded(second));

    const third = await commit(tabA, second, ended(second.records, 2));
    const fourth = await commit(tabA, third, started(third.records, 3));
    expect(encoded(await unwrap(tabB.load(second)))).toEqual(encoded(fourth));
  });

  test("版が1つだけ進んでいれば、変わったセッションだけを読み直す", async () => {
    const factory = new IDBFactory();
    const tabA = indexedDbVault(factory);
    const tabB = indexedDbVault(factory);
    const first = await commit(tabA, VaultContent.empty, twoSessions());
    const seen = await unwrap(tabB.load(VaultContent.empty));

    await rawPut(factory, `session:${closedIdOf(first.records)}`, "{");
    const second = await commit(tabA, first, written(first.records, 61));

    expect(encoded(await unwrap(tabB.load(seen)))).toEqual(encoded(second));
  });

  test("閉じたセッションを除いてコミットすると、そのセッションを消し、版を2つ進める", async () => {
    const factory = new IDBFactory();
    const vault = indexedDbVault(factory);
    const first = await commit(vault, VaultContent.empty, twoSessions());
    const closedId = closedIdOf(first.records);

    const second = await commit(vault, first, { ...first.records, closed: [] });

    expect(await rawGet(factory, "records", `session:${closedId}`)).toBeUndefined();
    expect(await metaOf(factory)).toEqual({ revision: first.revision + 2, changed: [] });
    const reloaded = await unwrap(indexedDbVault(factory).load(VaultContent.empty));
    expect(encoded(reloaded)).toEqual(encoded(second));
  });

  test("別のタブがセッションを消したら、全部を読み直して消えたセッションを読まない", async () => {
    const factory = new IDBFactory();
    const tabA = indexedDbVault(factory);
    const tabB = indexedDbVault(factory);
    const first = await commit(tabA, VaultContent.empty, twoSessions());
    const seen = await unwrap(tabB.load(VaultContent.empty));

    const second = await commit(tabA, first, { ...first.records, closed: [] });

    const reloaded = await unwrap(tabB.load(seen));
    expect(encoded(reloaded)).toEqual(encoded(second));
    expect(reloaded.records.closed).toEqual([]);
  });

  test("新しい版のアプリが IndexedDB の版を上げていたら 読みも書きもせず NewerFormat を返す", async () => {
    const factory = new IDBFactory();
    const newer = await database(factory, 2, (db) => {
      db.createObjectStore("records");
      db.createObjectStore("unreadable");
    });
    newer.close();

    const vault = indexedDbVault(factory);
    expect(await vault.load(VaultContent.empty)).toEqual(
      Result.fail({ kind: "NewerFormat" } satisfies { kind: "NewerFormat" }),
    );
    expect(await vault.commit(VaultContent.empty, started(DeviceRecords.empty, 0))).toEqual(
      Result.fail({ kind: "NewerFormat" }),
    );
  });

  test("読めない記録は上書きせず、生の値を退避する", async () => {
    const factory = new IDBFactory();
    const vault = indexedDbVault(factory);
    await commit(vault, VaultContent.empty, started(DeviceRecords.empty, 0));
    const broken = { revision: 1, changed: [], records: "{" };
    await rawPut(factory, "meta", broken);

    const fresh = indexedDbVault(factory);
    expect(await fresh.load(VaultContent.empty)).toEqual(Result.fail({ kind: "Broken" }));
    expect(await fresh.commit(VaultContent.empty, DeviceRecords.empty)).toEqual(
      Result.fail({ kind: "Broken" }),
    );

    expect(await rawGet(factory, "records", "meta")).toEqual(broken);
    expect(await rawGet(factory, "unreadable", "unreadable-1")).toEqual({
      meta: broken,
      sessions: [expect.any(String)],
    });
  });
});
