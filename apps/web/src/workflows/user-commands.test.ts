import { Result } from "@praha/byethrow";
import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { AdvanceModeChange } from "../domain/advance-mode.ts";
import type {
  DeletedJournalEntry,
  JournalEntry,
  JournalEntryId,
  StoredJournalEntry,
} from "../domain/journal-entry.ts";
import type {
  RecordedSessionEvent,
  SessionEventId,
  SessionOperation,
} from "../domain/session-event.ts";
import { SessionId, type Session } from "../domain/session.ts";
import type { SyncMessage } from "../domain/sync-message.ts";
import type { TagName } from "../domain/tag.ts";
import {
  changeAdvanceModeCommand,
  deleteJournalEntryCommand,
  deleteTagCommand,
  editJournalEntryCommand,
  operateSessionCommand,
  startSessionCommand,
  writeJournalEntryCommand,
} from "./user-commands.ts";

const NOW = new Date(Date.UTC(2026, 9, 17, 0, 0, 0));
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = v.parse(SessionId.schema, uuid(900));

const MANUAL = {
  FocusToJournal: "Manual",
  JournalToFocus: "Manual",
  JournalToBreak: "Manual",
  BreakToFocus: "Manual",
} as const;
const ALL_AUTO = {
  FocusToJournal: "Auto",
  JournalToFocus: "Auto",
  JournalToBreak: "Auto",
  BreakToFocus: "Auto",
} as const;

/** ワークフローの読み書きの契約を、メモリ上で満たす最小の記録先 */
const newStore = () => {
  let open: Session | undefined;
  const sessions: Session[] = [];
  const advanceModeChanges: AdvanceModeChange[] = [];
  const entries = new Map<string, StoredJournalEntry>();

  const writtenEntries = () =>
    [...entries.values()].flatMap((stored) => (stored.kind === "Written" ? [stored.entry] : []));

  return {
    findOpenSession: () => open,
    closeSession: () => {
      open = undefined;
    },
    findSessionByEventId: (eventId: SessionEventId) =>
      sessions.find((session) => session.events.some((event) => event.id === eventId)),
    saveStartedSession: (session: Session) => {
      sessions.push(session);
      open = session;
    },
    appendSessionOperation: (_id: SessionId, operation: RecordedSessionEvent<SessionOperation>) => {
      if (open !== undefined) {
        open = { ...open, events: [...open.events, operation] };
      }
    },
    loadAdvanceModeChanges: () => advanceModeChanges,
    saveAdvanceModeChange: (change: AdvanceModeChange) => {
      advanceModeChanges.push(change);
    },
    findJournalEntry: (id: JournalEntryId) => entries.get(id),
    saveJournalEntry: (entry: JournalEntry) => {
      entries.set(entry.id, { kind: "Written", entry });
    },
    saveEditedJournalEntry: (entry: JournalEntry) => {
      entries.set(entry.id, { kind: "Written", entry });
    },
    saveJournalEntryTags: (entry: JournalEntry) => {
      entries.set(entry.id, { kind: "Written", entry });
    },
    deleteJournalEntry: (deleted: DeletedJournalEntry) => {
      entries.set(deleted.id, { kind: "Deleted", deleted });
    },
    listTagsOfOtherEntries: (id: JournalEntryId) =>
      writtenEntries().flatMap((entry) => (entry.id === id ? [] : entry.tags)),
    listTagsInUse: () => [...new Set(writtenEntries().flatMap((entry) => entry.tags))],
    listJournalEntriesTaggedWith: (name: TagName) =>
      writtenEntries().filter((entry) => entry.tags.includes(name)),
  };
};

const kindsOf = (messages: ReadonlyArray<SyncMessage>) => messages.map((m) => m.kind);

const startedStore = () => {
  const store = newStore();
  const started = startSessionCommand(store)({ id: uuid(1) }, NOW, sessionId);
  expect(Result.isSuccess(started.result)).toBe(true);
  return store;
};

describe("セッションの開始", () => {
  test("開始するとセッションの変化を知らせる", () => {
    const { result, messages } = startSessionCommand(newStore())({ id: uuid(1) }, NOW, sessionId);

    expect(Result.isSuccess(result)).toBe(true);
    expect(messages).toEqual([{ kind: "SessionChanged", snapshot: Result.unwrap(result) }]);
  });

  test("セッションがあるうちに開始すると失敗し、何も知らせない", () => {
    const store = startedStore();

    const { result, messages } = startSessionCommand(store)({ id: uuid(2) }, later(1), sessionId);

    expect(Result.isFailure(result) && result.error.kind).toBe("SessionAlreadyInProgress");
    expect(messages).toEqual([]);
  });

  test("入力が不正なら失敗し、何も知らせない", () => {
    const { result, messages } = startSessionCommand(newStore())({}, NOW, sessionId);

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
    expect(messages).toEqual([]);
  });
});

describe("セッションへの操作", () => {
  test("一時停止するとセッションの変化を知らせる", () => {
    const store = startedStore();

    const { result, messages } = operateSessionCommand(store)(
      { id: uuid(2), kind: "Pause" },
      later(5),
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(kindsOf(messages)).toEqual(["SessionChanged"]);
  });

  test("セッションがなければ操作は失敗し、何も知らせない", () => {
    const { result, messages } = operateSessionCommand(newStore())(
      { id: uuid(2), kind: "Pause" },
      NOW,
    );

    expect(Result.isFailure(result) && result.error.kind).toBe("NoSessionInProgress");
    expect(messages).toEqual([]);
  });
});

describe("ジャーナル記入", () => {
  test("記入を書くと記入の保存とセッションの変化を知らせる", () => {
    const store = startedStore();

    const { result, messages } = writeJournalEntryCommand(store)(
      { id: uuid(10), body: "集中できた", tags: [] },
      later(30),
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(messages).toMatchObject([
      { kind: "JournalEntrySaved", entry: Result.unwrap(result) },
      { kind: "SessionChanged", snapshot: { kind: "Session" } },
    ]);
  });

  test("セッションの外で記入を書くと失敗し、何も知らせない", () => {
    const { result, messages } = writeJournalEntryCommand(newStore())(
      { id: uuid(10), body: "集中できた" },
      NOW,
    );

    expect(Result.isFailure(result) && result.error.kind).toBe("NoSessionInProgress");
    expect(messages).toEqual([]);
  });

  test("記入を編集すると記入の保存だけを知らせる", () => {
    const store = startedStore();
    writeJournalEntryCommand(store)({ id: uuid(10), body: "前", tags: [] }, later(30));

    const { result, messages } = editJournalEntryCommand(store)(
      uuid(10),
      { body: "後", tags: [] },
      later(60),
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(kindsOf(messages)).toEqual(["JournalEntrySaved"]);
  });

  test("ない記入を編集すると失敗し、何も知らせない", () => {
    const { result, messages } = editJournalEntryCommand(newStore())(
      uuid(10),
      { body: "後", tags: [] },
      NOW,
    );

    expect(Result.isFailure(result) && result.error.kind).toBe("JournalEntryNotFound");
    expect(messages).toEqual([]);
  });

  test("記入を削除すると記入の削除を知らせる", () => {
    const store = startedStore();
    writeJournalEntryCommand(store)({ id: uuid(10), body: "前", tags: [] }, later(30));

    const { result, messages } = deleteJournalEntryCommand(store)(uuid(10), later(60));

    expect(messages).toEqual([{ kind: "JournalEntryDeleted", deleted: Result.unwrap(result) }]);
  });
});

describe("タグの削除", () => {
  test("タグを外すと削除したタグだけを知らせ、書き換えた記入は知らせない", () => {
    const store = startedStore();
    writeJournalEntryCommand(store)({ id: uuid(10), body: "前", tags: ["仕事"] }, later(30));

    const { result, messages } = deleteTagCommand(store)("仕事", { kind: "Detach" });

    expect(messages).toEqual([{ kind: "TagDeleted", deleted: Result.unwrap(result) }]);
  });

  test("使っていないタグを削除すると失敗し、何も知らせない", () => {
    const { result, messages } = deleteTagCommand(newStore())("仕事", { kind: "Detach" });

    expect(Result.isFailure(result) && result.error.kind).toBe("TagNotFound");
    expect(messages).toEqual([]);
  });
});

describe("フェーズの進め方", () => {
  test("フェーズの進め方を変えるとセッションがあれば進め方の変化とセッションの変化を知らせる", () => {
    const store = startedStore();

    const { result, messages } = changeAdvanceModeCommand(store)(MANUAL, later(10));

    expect(Result.unwrap(result)).toEqual(MANUAL);
    expect(kindsOf(messages)).toEqual(["AdvanceModeChanged", "SessionChanged"]);
  });

  test("フェーズの進め方を変えてもセッションがなければセッションの変化は知らせない", () => {
    const { result, messages } = changeAdvanceModeCommand(newStore())(MANUAL, NOW);

    expect(Result.isSuccess(result)).toBe(true);
    expect(messages).toEqual([{ kind: "AdvanceModeChanged", mode: MANUAL }]);
  });

  test("いまと同じ進め方にしても何も知らせない", () => {
    const { result, messages } = changeAdvanceModeCommand(startedStore())(ALL_AUTO, later(10));

    expect(Result.isSuccess(result)).toBe(true);
    expect(messages).toEqual([]);
  });

  test("入力が不正なら失敗し、何も知らせない", () => {
    const { result, messages } = changeAdvanceModeCommand(newStore())({}, NOW);

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
    expect(messages).toEqual([]);
  });
});
