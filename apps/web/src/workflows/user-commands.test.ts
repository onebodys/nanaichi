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
  expect(Result.isSuccess(started)).toBe(true);
  return store;
};

describe("セッションの開始", () => {
  test("開始するとセッションの変化を知らせる", () => {
    const result = startSessionCommand(newStore())({ id: uuid(1) }, NOW, sessionId);

    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.unwrap(result).messages).toEqual([
      { kind: "SessionChanged", snapshot: Result.unwrap(result).value },
    ]);
  });

  test("セッションがあるうちに開始すると失敗し、何も知らせない", () => {
    const store = startedStore();

    const result = startSessionCommand(store)({ id: uuid(2) }, later(1), sessionId);

    expect(Result.isFailure(result) && result.error.kind).toBe("SessionAlreadyInProgress");
  });

  test("入力が不正なら失敗し、何も知らせない", () => {
    const result = startSessionCommand(newStore())({}, NOW, sessionId);

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
  });
});

describe("セッションへの操作", () => {
  test("一時停止するとセッションの変化を知らせる", () => {
    const store = startedStore();

    const result = operateSessionCommand(store)({ id: uuid(2), kind: "Pause" }, later(5));

    expect(Result.isSuccess(result)).toBe(true);
    expect(kindsOf(Result.unwrap(result).messages)).toEqual(["SessionChanged"]);
  });

  test("セッションがなければ操作は失敗し、何も知らせない", () => {
    const result = operateSessionCommand(newStore())({ id: uuid(2), kind: "Pause" }, NOW);

    expect(Result.isFailure(result) && result.error.kind).toBe("NoSessionInProgress");
  });
});

describe("ジャーナル記入", () => {
  test("記入を書くと記入の保存とセッションの変化を知らせる", () => {
    const store = startedStore();

    const result = writeJournalEntryCommand(store)(
      { id: uuid(10), body: "集中できた", tags: [] },
      later(30),
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.unwrap(result).messages).toMatchObject([
      { kind: "JournalEntrySaved", entry: Result.unwrap(result).value },
      { kind: "SessionChanged", snapshot: { kind: "Session" } },
    ]);
  });

  test("セッションの外で記入を書くと失敗し、何も知らせない", () => {
    const result = writeJournalEntryCommand(newStore())({ id: uuid(10), body: "集中できた" }, NOW);

    expect(Result.isFailure(result) && result.error.kind).toBe("NoSessionInProgress");
  });

  test("記入を編集すると記入の保存だけを知らせる", () => {
    const store = startedStore();
    writeJournalEntryCommand(store)({ id: uuid(10), body: "前", tags: [] }, later(30));

    const result = editJournalEntryCommand(store)(uuid(10), { body: "後", tags: [] }, later(60));

    expect(Result.isSuccess(result)).toBe(true);
    expect(kindsOf(Result.unwrap(result).messages)).toEqual(["JournalEntrySaved"]);
  });

  test("ない記入を編集すると失敗し、何も知らせない", () => {
    const result = editJournalEntryCommand(newStore())(uuid(10), { body: "後", tags: [] }, NOW);

    expect(Result.isFailure(result) && result.error.kind).toBe("JournalEntryNotFound");
  });

  test("記入を削除すると記入の削除を知らせる", () => {
    const store = startedStore();
    writeJournalEntryCommand(store)({ id: uuid(10), body: "前", tags: [] }, later(30));

    const result = deleteJournalEntryCommand(store)(uuid(10), later(60));

    expect(Result.unwrap(result).messages).toEqual([
      { kind: "JournalEntryDeleted", deleted: Result.unwrap(result).value },
    ]);
  });
});

describe("タグの削除", () => {
  test("タグを外すと削除したタグだけを知らせ、書き換えた記入は知らせない", () => {
    const store = startedStore();
    writeJournalEntryCommand(store)({ id: uuid(10), body: "前", tags: ["仕事"] }, later(30));

    const result = deleteTagCommand(store)("仕事", { kind: "Detach" });

    expect(Result.unwrap(result).messages).toEqual([
      { kind: "TagDeleted", deleted: Result.unwrap(result).value },
    ]);
  });

  test("使っていないタグを削除すると失敗し、何も知らせない", () => {
    const result = deleteTagCommand(newStore())("仕事", { kind: "Detach" });

    expect(Result.isFailure(result) && result.error.kind).toBe("TagNotFound");
  });
});

describe("フェーズの進め方", () => {
  test("フェーズの進め方を変えるとセッションがあれば進め方の変化とセッションの変化を知らせる", () => {
    const store = startedStore();

    const result = changeAdvanceModeCommand(store)(MANUAL, later(10));

    expect(Result.unwrap(result).value).toEqual(MANUAL);
    expect(kindsOf(Result.unwrap(result).messages)).toEqual([
      "AdvanceModeChanged",
      "SessionChanged",
    ]);
  });

  test("フェーズの進め方を変えてもセッションがなければセッションの変化は知らせない", () => {
    const result = changeAdvanceModeCommand(newStore())(MANUAL, NOW);

    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.unwrap(result).messages).toEqual([{ kind: "AdvanceModeChanged", mode: MANUAL }]);
  });

  test("いまと同じ進め方にしても何も知らせない", () => {
    const result = changeAdvanceModeCommand(startedStore())(ALL_AUTO, later(10));

    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.unwrap(result).messages).toEqual([]);
  });

  test("入力が不正なら失敗し、何も知らせない", () => {
    const result = changeAdvanceModeCommand(newStore())({}, NOW);

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
  });
});
