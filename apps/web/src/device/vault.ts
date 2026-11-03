import { Result } from "@praha/byethrow";
import * as v from "valibot";
import type { SessionRecord } from "../domain/session-record.ts";
import { SessionId } from "../domain/session.ts";
import {
  changedSessionRecords,
  DeviceRecords,
  removedSessionIds,
  sessionRecordsOf,
} from "./records.ts";
import {
  assembleRecords,
  decodeMetaRecord,
  decodeRecords,
  decodeSessionRecord,
  encodeMetaRecord,
  encodeSessionRecord,
  type RecordsUnreadable,
} from "./records-json.ts";

/** 保存先から読み込んだ記録。`revision` は書き込むたびに進む（`nextRevision`） */
export type VaultContent = Readonly<{ revision: number; records: DeviceRecords }>;

export const VaultContent = {
  empty: { revision: 0, records: DeviceRecords.empty },
} as const satisfies Readonly<{ empty: VaultContent }>;

export type VaultFailure =
  | Readonly<{ kind: "Unavailable" }>
  | Readonly<{ kind: "QuotaExceeded" }>
  /** 新しい版のアプリが書いた記録。読めないので、上書きもしない */
  | Readonly<{ kind: "NewerFormat" }>
  /** 壊れた記録。上書きしない */
  | Readonly<{ kind: "Broken" }>;

/**
 * この端末の記録の保存先（ADR 0019）。読み込みと書き込みのあいだに別のタブが書かないことは、
 * 呼び出す側がタブをまたぐロックで守る。
 */
export type Vault = Readonly<{
  /** `cached` のあとに書かれたものだけを読み直す */
  load: (cached: VaultContent) => Result.ResultAsync<VaultContent, VaultFailure>;
  /** `previous` から変わったセッションと進め方の履歴を書き、なくなったセッションを消す。1つのトランザクションで */
  commit: (
    previous: VaultContent,
    records: DeviceRecords,
  ) => Result.ResultAsync<VaultContent, VaultFailure>;
}>;

type StoredMeta = Readonly<{
  revision: number;
  changed: ReadonlyArray<SessionId>;
  records: string;
}>;

const StoredMetaSchema = v.object({
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  changed: v.array(SessionId.schema),
  records: v.string(),
});

const RevisionSchema = v.object({ revision: v.number() });

type EncodedSession = Readonly<{ id: SessionId; raw: string }>;

type UnreadableCopy = Readonly<{ meta: unknown; sessions: ReadonlyArray<unknown> }>;

type RawStore = Readonly<{
  readMeta: () => Promise<unknown>;
  readSessions: (ids: ReadonlyArray<SessionId>) => Promise<ReadonlyArray<unknown>>;
  readAllSessions: () => Promise<ReadonlyArray<unknown>>;
  write: (
    expectedRevision: number,
    meta: StoredMeta,
    sessions: ReadonlyArray<EncodedSession>,
    removed: ReadonlyArray<SessionId>,
  ) => Promise<void>;
  keepFirstUnreadable: (key: string, copy: UnreadableCopy) => Promise<void>;
}>;

/**
 * 書き込んだあとの版。ほかのタブは、版が1つだけ進んでいれば `meta.changed` のセッションだけを読み直し、
 * それ以外は全部を読み直す（`readSince`）。差分の読み直しは消したセッションを知らないので、
 * セッションを消したときは版を2つ進め、どのタブにも（古い版のアプリのタブにも）全部を読み直させる。
 * meta の形を変えずに済む
 */
const nextRevision = (previous: number, removed: ReadonlyArray<SessionId>): number =>
  previous + (removed.length === 0 ? 1 : 2);

const revisionOf = (meta: unknown): number => {
  const parsed = v.safeParse(RevisionSchema, meta);
  return parsed.success ? parsed.output.revision : 0;
};

const staleRevision = () =>
  new Error("読み込んだあとに別の書き込みがあった。タブをまたぐロックの外で書いている");

const failureOf = (error: DOMException): VaultFailure => {
  switch (error.name) {
    case "QuotaExceededError":
      return { kind: "QuotaExceeded" };
    // 新しい版のアプリが IndexedDB の版を上げていると、古い版では開けない
    case "VersionError":
      return { kind: "NewerFormat" };
    default:
      return { kind: "Unavailable" };
  }
};

const guarded = async <T>(
  operation: () => Promise<Result.Result<T, VaultFailure>>,
): Promise<Result.Result<T, VaultFailure>> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DOMException) {
      return Result.fail(failureOf(error));
    }
    throw error;
  }
};

const unreadableFailure = (unreadable: RecordsUnreadable): VaultFailure => {
  switch (unreadable.kind) {
    case "NewerFormat":
      return { kind: "NewerFormat" };
    case "Malformed":
      return { kind: "Broken" };
  }
};

const malformed = (path: string): RecordsUnreadable => ({ kind: "Malformed", paths: [path] });

const textOf = (raw: unknown): Result.Result<string, RecordsUnreadable> =>
  typeof raw === "string" ? Result.succeed(raw) : Result.fail(malformed("(session)"));

const parseMeta = (raw: unknown): Result.Result<StoredMeta, RecordsUnreadable> => {
  const parsed = v.safeParse(StoredMetaSchema, raw);
  return parsed.success ? Result.succeed(parsed.output) : Result.fail(malformed("(meta)"));
};

const decodeAll = (meta: StoredMeta, raws: ReadonlyArray<unknown>) =>
  Result.pipe(
    Result.sequence(raws, textOf),
    Result.andThen((sessions) => decodeRecords(meta.records, sessions)),
  );

const decodeChanges = (cached: DeviceRecords, meta: StoredMeta, raws: ReadonlyArray<unknown>) =>
  Result.pipe(
    Result.do(),
    Result.bind("meta", () => decodeMetaRecord(meta.records)),
    Result.bind("changed", () =>
      Result.sequence(raws, (raw) => Result.pipe(textOf(raw), Result.andThen(decodeSessionRecord))),
    ),
    Result.andThen(({ meta, changed }) => {
      const byId = new Map<SessionId, SessionRecord>(
        sessionRecordsOf(cached).map((record) => [record.session.id, record]),
      );
      for (const record of changed) {
        byId.set(record.session.id, record);
      }
      return assembleRecords(meta.advanceModeChanges, [...byId.values()]);
    }),
  );

const vaultOver = (raw: RawStore): Vault => {
  let latchedFailure: VaultFailure | undefined;

  const keepAndReport = async (
    failure: VaultFailure,
    meta: unknown,
  ): Promise<Result.Result<never, VaultFailure>> => {
    const sessions = await raw.readAllSessions();
    await raw.keepFirstUnreadable(`unreadable-${revisionOf(meta)}`, { meta, sessions });
    latchedFailure = failure;
    return Result.fail(failure);
  };

  const readSince = async (
    cached: VaultContent,
    meta: StoredMeta,
  ): Promise<Result.Result<DeviceRecords, RecordsUnreadable>> =>
    meta.revision === cached.revision + 1
      ? decodeChanges(cached.records, meta, await raw.readSessions(meta.changed))
      : decodeAll(meta, await raw.readAllSessions());

  return {
    load: (cached) =>
      guarded(async () => {
        if (latchedFailure !== undefined) {
          return Result.fail(latchedFailure);
        }
        const metaRaw = await raw.readMeta();
        if (metaRaw === undefined) {
          return Result.succeed(VaultContent.empty);
        }
        const meta = parseMeta(metaRaw);
        if (Result.isFailure(meta)) {
          return keepAndReport(unreadableFailure(meta.error), metaRaw);
        }
        if (meta.value.revision === cached.revision) {
          return Result.succeed(cached);
        }
        const records = await readSince(cached, meta.value);
        if (Result.isFailure(records)) {
          return keepAndReport(unreadableFailure(records.error), metaRaw);
        }
        return Result.succeed({ revision: meta.value.revision, records: records.value });
      }),

    commit: (previous, records) =>
      guarded(async () => {
        if (latchedFailure !== undefined) {
          return Result.fail(latchedFailure);
        }
        const changed = changedSessionRecords(previous.records, records);
        const removed = removedSessionIds(previous.records, records);
        const revision = nextRevision(previous.revision, removed);
        await raw.write(
          previous.revision,
          {
            revision,
            changed: changed.map(({ session }) => session.id),
            records: encodeMetaRecord(records),
          },
          changed.map((record) => ({ id: record.session.id, raw: encodeSessionRecord(record) })),
          removed,
        );
        return Result.succeed({ revision, records });
      }),
  };
};

export type MemoryStore = {
  meta: unknown;
  sessions: Map<SessionId, unknown>;
  unreadable: Map<string, UnreadableCopy>;
  failWrites: DOMException | undefined;
};

export const MemoryStore = {
  empty: (): MemoryStore => ({
    meta: undefined,
    sessions: new Map(),
    unreadable: new Map(),
    failWrites: undefined,
  }),
} as const;

export const memoryVault = (store: MemoryStore = MemoryStore.empty()): Vault =>
  vaultOver({
    readMeta: async () => store.meta,
    readSessions: async (ids) => ids.map((id) => store.sessions.get(id)),
    readAllSessions: async () => [...store.sessions.values()],
    write: async (expectedRevision, meta, sessions, removed) => {
      if (revisionOf(store.meta) !== expectedRevision) {
        throw staleRevision();
      }
      if (store.failWrites !== undefined) {
        throw store.failWrites;
      }
      for (const { id, raw } of sessions) {
        store.sessions.set(id, raw);
      }
      for (const id of removed) {
        store.sessions.delete(id);
      }
      store.meta = meta;
    },
    keepFirstUnreadable: async (key, copy) => {
      if (!store.unreadable.has(key)) {
        store.unreadable.set(key, copy);
      }
    },
  });

const DATABASE = "nanaichi-device";
// 保存の形を変えるときは版を上げる。古い版のアプリは VersionError で開けず、新しい版の記録に書かない
const DATABASE_VERSION = 1;
const RECORDS = "records";
const UNREADABLE = "unreadable";
const META_KEY = "meta";
const SESSION_KEY_PREFIX = "session:";

const sessionKey = (id: SessionId) => `${SESSION_KEY_PREFIX}${id}`;

const requested = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

const completed = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new DOMException("トランザクションを取り消した", "AbortError")),
    );
  });

const openDatabase = (factory: IDBFactory | undefined): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (factory === undefined) {
      reject(new DOMException("IndexedDB が使えない", "NotSupportedError"));
      return;
    }
    const request = factory.open(DATABASE, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(RECORDS);
      request.result.createObjectStore(UNREADABLE);
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

/**
 * IndexedDB の保存先。オブジェクトストア1つに、セッションごとに1件（`session:<id>`）と `meta` を1件置く。
 * 1回の書き込みは、変わったセッションと `meta` を書き、消したセッションを消すのを1つのトランザクションで行うので、
 * 全部書くか何も書かないか。
 */
export const indexedDbVault = (factory: IDBFactory | undefined): Vault => {
  let opened: Promise<IDBDatabase> | undefined;

  const database = (): Promise<IDBDatabase> => {
    opened ??= openDatabase(factory).then(
      (db) => {
        // 新しい版のアプリが版を上げられるよう閉じる。次の呼び出しで開き直し、VersionError になる
        db.addEventListener("versionchange", () => {
          db.close();
          opened = undefined;
        });
        return db;
      },
      (error: unknown) => {
        opened = undefined;
        throw error;
      },
    );
    return opened;
  };

  const store = async (name: string, mode: IDBTransactionMode) => {
    const transaction = (await database()).transaction(name, mode);
    return { transaction, store: transaction.objectStore(name) };
  };

  return vaultOver({
    readMeta: async () => {
      const { store: records } = await store(RECORDS, "readonly");
      return requested(records.get(META_KEY));
    },

    readSessions: async (ids) => {
      const { store: records } = await store(RECORDS, "readonly");
      return Promise.all(ids.map((id) => requested(records.get(sessionKey(id)))));
    },

    readAllSessions: async () => {
      const { store: records } = await store(RECORDS, "readonly");
      const [keys, values] = await Promise.all([
        requested(records.getAllKeys()),
        requested(records.getAll()),
      ]);
      return values.filter((_, index) => keys[index] !== META_KEY);
    },

    write: async (expectedRevision, meta, sessions, removed) => {
      const { transaction, store: records } = await store(RECORDS, "readwrite");
      const done = completed(transaction);
      for (const { id, raw } of sessions) {
        records.put(raw, sessionKey(id));
      }
      for (const id of removed) {
        records.delete(sessionKey(id));
      }
      let stale = false;
      const current = records.get(META_KEY);
      current.addEventListener("success", () => {
        if (revisionOf(current.result) !== expectedRevision) {
          stale = true;
          transaction.abort();
          return;
        }
        records.put(meta, META_KEY);
      });
      try {
        await done;
      } catch (error) {
        throw stale ? staleRevision() : error;
      }
    },

    keepFirstUnreadable: async (key, copy) => {
      const { transaction, store: unreadable } = await store(UNREADABLE, "readwrite");
      const done = completed(transaction);
      const existing = unreadable.getKey(key);
      existing.addEventListener("success", () => {
        if (existing.result === undefined) {
          unreadable.put(copy, key);
        }
      });
      await done;
    },
  });
};
