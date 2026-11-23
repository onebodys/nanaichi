import { Result } from "@praha/byethrow";
import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import type { AdvanceModeChange } from "../domain/advance-mode.ts";
import {
  Import,
  ImportBatch,
  type ClosedSessionSpan,
  type ImportBatch as Batch,
} from "../domain/import.ts";
import {
  JournalEntryId,
  type DeletedJournalEntry,
  type JournalEntry,
  type StoredJournalEntry,
} from "../domain/journal-entry.ts";
import {
  SessionEventId,
  type RecordedSessionEvent,
  type SessionOperation,
} from "../domain/session-event.ts";
import { Revision, SessionId, type Session } from "../domain/session.ts";
import { Sensitive } from "../domain/sensitive.ts";
import type { ClosedSession } from "../domain/session-record.ts";
import type { SyncMessage } from "../domain/sync-message.ts";
import type { TagName } from "../domain/tag.ts";
import type { FinishDecisionRun } from "../domain/task-decision.ts";
import { TaskSetting } from "../domain/task-setting.ts";
import { Probability, TaskId, type Task, type TaskJudgment } from "../domain/task.ts";
import { getAdvanceMode } from "./get-advance-mode.ts";
import { getTaskSetting } from "./get-task-setting.ts";
import { getTasks } from "./get-tasks.ts";
import {
  changeAdvanceModeCommand,
  changeTaskSettingCommand,
  completeTaskCommand,
  createTaskCommand,
  deleteJournalEntryCommand,
  deleteTagCommand,
  deleteTaskCommand,
  editJournalEntryCommand,
  finishCompletionFromJournalCommand,
  importSessionsCommand,
  operateSessionCommand,
  renameTaskCommand,
  reopenTaskCommand,
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
  const tasks = new Map<TaskId, Task>();
  let taskSetting: TaskSetting = TaskSetting.default;
  const decisionRuns = new Map<
    JournalEntryId,
    Readonly<{ outcome: Parameters<FinishDecisionRun>[1]; inputTokens: number }>
  >();
  const taskJudgments = new Map<JournalEntryId, ReadonlyArray<TaskJudgment>>();
  const imported: ClosedSession[] = [];
  // 取り込みで足したのではない記録（開始したセッション・変えた進め方）があるか
  let hasOwnRecords = false;
  // 記録を変えるたびに進める（記録先の変更の番号、ADR 0030）
  let revision = 0;
  const changed = () => {
    revision += 1;
  };

  const writtenEntries = () =>
    [...entries.values()].flatMap((stored) => (stored.kind === "Written" ? [stored.entry] : []));

  return {
    findOpenSession: () => open,
    currentRevision: () => v.parse(Revision.schema, revision),
    closeSession: () => {
      changed();
      open = undefined;
    },
    findSessionByEventId: (eventId: SessionEventId) =>
      sessions.find((session) => session.events.some((event) => event.id === eventId)),
    saveStartedSession: (session: Session) => {
      changed();
      hasOwnRecords = true;
      sessions.push(session);
      open = session;
    },
    appendSessionOperation: (_id: SessionId, operation: RecordedSessionEvent<SessionOperation>) => {
      changed();
      if (open !== undefined) {
        open = { ...open, events: [...open.events, operation] };
      }
    },
    // 時刻の順。同じ時刻なら足した順（SQLite の `ORDER BY changed_at, rowid`）
    loadAdvanceModeChanges: () =>
      advanceModeChanges.toSorted((a, b) => a.at.getTime() - b.at.getTime()),
    saveAdvanceModeChange: (change: AdvanceModeChange) => {
      changed();
      hasOwnRecords = true;
      advanceModeChanges.push(change);
    },
    findJournalEntry: (id: JournalEntryId) => entries.get(id),
    saveJournalEntry: (entry: JournalEntry) => {
      changed();
      entries.set(entry.id, { kind: "Written", entry });
    },
    saveEditedJournalEntry: (entry: JournalEntry) => {
      changed();
      entries.set(entry.id, { kind: "Written", entry });
    },
    saveJournalEntryTags: (entry: JournalEntry) => {
      changed();
      entries.set(entry.id, { kind: "Written", entry });
    },
    deleteJournalEntry: (deleted: DeletedJournalEntry) => {
      changed();
      entries.set(deleted.id, { kind: "Deleted", deleted });
    },
    listTagsOfOtherEntries: (id: JournalEntryId) =>
      writtenEntries().flatMap((entry) => (entry.id === id ? [] : entry.tags)),
    listTagsInUse: () => [...new Set(writtenEntries().flatMap((entry) => entry.tags))],
    listJournalEntriesTaggedWith: (name: TagName) =>
      writtenEntries().filter((entry) => entry.tags.includes(name)),
    findTask: (id: TaskId) => tasks.get(id),
    // Map は最初に入れた順を保つので、作った順に並ぶ
    listTasks: () => [...tasks.values()],
    saveTask: (task: Task) => {
      changed();
      tasks.set(task.id, task);
    },
    deleteTask: (id: TaskId) => {
      changed();
      tasks.delete(id);
    },
    loadTaskSetting: () => taskSetting,
    saveTaskSetting: (setting: TaskSetting) => {
      changed();
      taskSetting = setting;
    },
    saveTaskJudgments: (entryId: JournalEntryId, judgments: ReadonlyArray<TaskJudgment>) => {
      taskJudgments.set(entryId, judgments);
    },
    finishDecisionRun: ((entryId, outcome, inputTokens) => {
      decisionRuns.set(entryId, { outcome, inputTokens });
    }) satisfies FinishDecisionRun,
    /** 記録した判断の結果と判断モデルの答え（テストで確かめる） */
    decisionRunOf: (entryId: JournalEntryId) => decisionRuns.get(entryId),
    taskJudgmentsOf: (entryId: JournalEntryId) => taskJudgments.get(entryId),
    sessionExists: (id: SessionId) =>
      sessions.some((session) => session.id === id) ||
      imported.some((session) => session.id === id),
    findOverlappingSession: (span: ClosedSessionSpan) =>
      [
        ...(open === undefined
          ? []
          : [{ id: open.id, span: { kind: "Open", startedAt: open.events[0].at } as const }]),
        ...imported.map((session) => ({ id: session.id, span: Import.spanOf(session) })),
      ].find((other) => Import.overlaps(other.span, span))?.id,
    loadAccountRecords: () =>
      hasOwnRecords ? ({ kind: "HasOwnRecords" } as const) : ({ kind: "OnlyImported" } as const),
    saveImportedSession: (session: ClosedSession) => {
      changed();
      imported.push(session);
    },
    saveImportedAdvanceModeChange: (change: AdvanceModeChange) => {
      changed();
      advanceModeChanges.push(change);
    },
    /** 取り込んだセッションの ID（テストで確かめる） */
    importedSessionIds: () => imported.map((session) => session.id),
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

describe("操作イベントの再送", () => {
  test("記録済みの開始と同じ ID で別の操作が届くと、ID の衝突として失敗し、何も知らせない", () => {
    const store = startedStore();

    const result = operateSessionCommand(store)({ id: uuid(1), kind: "Pause" }, later(5));

    expect(result).toEqual(Result.fail({ kind: "EventIdConflict", eventId: uuid(1) }));
  });
});

describe("ジャーナル記入の削除の失敗", () => {
  test("ない記入を削除すると失敗し、何も知らせない", () => {
    const result = deleteJournalEntryCommand(startedStore())(uuid(10), later(60));

    expect(result).toEqual(Result.fail({ kind: "JournalEntryNotFound", id: uuid(10) }));
  });
});

// ---------------------------------------------------------------------------
// タスク
// ---------------------------------------------------------------------------

const taskId = (n: number) => v.parse(TaskId.schema, uuid(n));

const tasksOf = (store: ReturnType<typeof newStore>) => Result.unwrap(getTasks(store)()).tasks;

/** タスク `n` を作り、記録したタスクを返す */
const createdTask = (store: ReturnType<typeof newStore>, n: number, title: string) =>
  Result.unwrap(createTaskCommand(store)({ id: uuid(n), title }, NOW)).value;

/** タスク `n` を作って完了にし、完了したタスクを返す */
const completedTask = (store: ReturnType<typeof newStore>, n: number, at: Date) => {
  createdTask(store, n, "牛乳を買う");
  return Result.unwrap(completeTaskCommand(store)(uuid(n), at)).value;
};

describe("タスクの作成", () => {
  test("タスクを作ると未完了のタスクとして記録し、保存したタスクを知らせる", () => {
    const store = newStore();

    const result = createTaskCommand(store)({ id: uuid(1), title: "牛乳を買う" }, NOW);

    const task = { kind: "Open", id: uuid(1), title: "牛乳を買う", createdAt: NOW, updatedAt: NOW };
    expect(result).toEqual(
      Result.succeed({ value: task, messages: [{ kind: "TaskSaved", task }] }),
    );
    expect(tasksOf(store)).toEqual([task]);
  });

  test("タイトルの前後の空白は落として記録する", () => {
    const store = newStore();

    createTaskCommand(store)({ id: uuid(1), title: "  牛乳を買う  " }, NOW);

    expect(tasksOf(store)).toMatchObject([{ title: "牛乳を買う" }]);
  });

  test("同じ ID のタスクがもう一度届くと、1回目に記録したタスクを返して記録し直さない", () => {
    const store = newStore();
    const first = createdTask(store, 1, "牛乳を買う");

    const result = createTaskCommand(store)({ id: uuid(1), title: "卵を買う" }, later(60));

    expect(Result.unwrap(result).value).toEqual(first);
    expect(tasksOf(store)).toEqual([first]);
  });

  test("タイトルが空白だけなら作れず、何も記録しない", () => {
    const store = newStore();

    const result = createTaskCommand(store)({ id: uuid(1), title: "   " }, NOW);

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
    expect(tasksOf(store)).toEqual([]);
  });
});

describe("タスクのタイトルの変更", () => {
  test("タイトルを変えると変えた時刻とともに記録し、保存したタスクを知らせる", () => {
    const store = newStore();
    createdTask(store, 1, "牛乳を買う");

    const result = renameTaskCommand(store)(uuid(1), { title: "卵を買う" }, later(60));

    const task = {
      kind: "Open",
      id: uuid(1),
      title: "卵を買う",
      createdAt: NOW,
      updatedAt: later(60),
    };
    expect(result).toEqual(
      Result.succeed({ value: task, messages: [{ kind: "TaskSaved", task }] }),
    );
    expect(tasksOf(store)).toEqual([task]);
  });

  test("完了したタスクのタイトルを変えても完了のまま", () => {
    const store = newStore();
    const completed = completedTask(store, 1, later(30));

    renameTaskCommand(store)(uuid(1), { title: "卵を買う" }, later(60));

    expect(tasksOf(store)).toEqual([{ ...completed, title: "卵を買う", updatedAt: later(60) }]);
  });

  test("ないタスクのタイトルを変えると失敗し、何も知らせない", () => {
    const result = renameTaskCommand(newStore())(uuid(1), { title: "卵を買う" }, NOW);

    expect(result).toEqual(Result.fail({ kind: "TaskNotFound", id: uuid(1) }));
  });

  test("タスクの ID が不正なら失敗する", () => {
    const result = renameTaskCommand(newStore())("1", { title: "卵を買う" }, NOW);

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
  });

  test("新しいタイトルが空なら失敗し、タイトルは変わらない", () => {
    const store = newStore();
    const task = createdTask(store, 1, "牛乳を買う");

    const result = renameTaskCommand(store)(uuid(1), { title: "" }, later(60));

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
    expect(tasksOf(store)).toEqual([task]);
  });
});

describe("タスクの完了", () => {
  test("未完了のタスクを完了にすると、手動の完了として記録し、保存したタスクを知らせる", () => {
    const store = newStore();
    createdTask(store, 1, "牛乳を買う");

    const result = completeTaskCommand(store)(uuid(1), later(60));

    const task = {
      kind: "Completed",
      id: uuid(1),
      title: "牛乳を買う",
      createdAt: NOW,
      updatedAt: later(60),
      completedAt: later(60),
      completion: { kind: "Manual" },
    };
    expect(result).toEqual(
      Result.succeed({ value: task, messages: [{ kind: "TaskSaved", task }] }),
    );
    expect(tasksOf(store)).toEqual([task]);
  });

  test("完了したタスクをもう一度完了にすると、先に完了にした時刻のまま返す", () => {
    const store = newStore();
    const completed = completedTask(store, 1, later(60));

    const result = completeTaskCommand(store)(uuid(1), later(120));

    expect(Result.unwrap(result)).toEqual({
      value: completed,
      messages: [{ kind: "TaskSaved", task: completed }],
    });
    expect(tasksOf(store)).toEqual([completed]);
  });

  test("ないタスクを完了にすると失敗し、何も知らせない", () => {
    const result = completeTaskCommand(newStore())(uuid(1), NOW);

    expect(result).toEqual(Result.fail({ kind: "TaskNotFound", id: uuid(1) }));
  });

  test("タスクの ID が不正なら完了にできない", () => {
    const result = completeTaskCommand(newStore())("1", NOW);

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
  });
});

describe("タスクの再開", () => {
  test("完了したタスクを再開すると未完了に戻り、完了した時刻とそのしかたは消える", () => {
    const store = newStore();
    completedTask(store, 1, later(60));

    const result = reopenTaskCommand(store)(uuid(1), later(120));

    const task = {
      kind: "Open",
      id: uuid(1),
      title: "牛乳を買う",
      createdAt: NOW,
      updatedAt: later(120),
    };
    expect(result).toEqual(
      Result.succeed({ value: task, messages: [{ kind: "TaskSaved", task }] }),
    );
    expect(tasksOf(store)).toEqual([task]);
  });

  test("未完了のタスクを再開しても、記録済みのタスクをそのまま返す", () => {
    const store = newStore();
    const task = createdTask(store, 1, "牛乳を買う");

    const result = reopenTaskCommand(store)(uuid(1), later(60));

    expect(Result.unwrap(result).value).toEqual(task);
    expect(tasksOf(store)).toEqual([task]);
  });

  test("ないタスクを再開すると失敗し、何も知らせない", () => {
    const result = reopenTaskCommand(newStore())(uuid(1), NOW);

    expect(result).toEqual(Result.fail({ kind: "TaskNotFound", id: uuid(1) }));
  });

  test("タスクの ID が不正なら再開できない", () => {
    const result = reopenTaskCommand(newStore())("1", NOW);

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
  });
});

describe("タスクの削除", () => {
  test("タスクを削除すると一覧から消え、削除したタスクを知らせる", () => {
    const store = newStore();
    createdTask(store, 1, "牛乳を買う");
    const kept = createdTask(store, 2, "卵を買う");

    const result = deleteTaskCommand(store)(uuid(1));

    expect(result).toEqual(
      Result.succeed({
        value: { id: uuid(1) },
        messages: [{ kind: "TaskDeleted", deleted: { id: uuid(1) } }],
      }),
    );
    expect(tasksOf(store)).toEqual([kept]);
  });

  test("ないタスクを削除すると失敗し、何も知らせない", () => {
    const result = deleteTaskCommand(newStore())(uuid(1));

    expect(result).toEqual(Result.fail({ kind: "TaskNotFound", id: uuid(1) }));
  });

  test("タスクの ID が不正なら削除できない", () => {
    const result = deleteTaskCommand(newStore())("1");

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
  });
});

describe("タスクの一覧", () => {
  test("タスクを作った順に返し、タイトルを変えても順は変わらない", () => {
    const store = newStore();
    createdTask(store, 1, "牛乳を買う");
    createdTask(store, 2, "卵を買う");
    renameTaskCommand(store)(uuid(1), { title: "パンを買う" }, later(60));

    expect(tasksOf(store).map(({ title }) => title)).toEqual(["パンを買う", "卵を買う"]);
  });

  test("タスクがなければ空の一覧を返す", () => {
    expect(Result.unwrap(getTasks(newStore())())).toEqual({ tasks: [] });
  });
});

describe("ToDo の設定", () => {
  test("変えたことがなければ ToDo の設定は無効", () => {
    expect(getTaskSetting(newStore())()).toEqual(Result.succeed({ kind: "Disabled" }));
  });

  test("ToDo の設定を有効にすると記録し、ToDo の設定の変化を知らせる", () => {
    const store = newStore();

    const result = changeTaskSettingCommand(store)({ kind: "Enabled" });

    expect(result).toEqual(
      Result.succeed({
        value: { kind: "Enabled" },
        messages: [{ kind: "TaskSettingChanged", setting: { kind: "Enabled" } }],
      }),
    );
    expect(getTaskSetting(store)()).toEqual(Result.succeed({ kind: "Enabled" }));
  });

  test("有効にした ToDo の設定を無効に戻すと記録し、ToDo の設定の変化を知らせる", () => {
    const store = newStore();
    changeTaskSettingCommand(store)({ kind: "Enabled" });

    const result = changeTaskSettingCommand(store)({ kind: "Disabled" });

    expect(Result.unwrap(result).messages).toEqual([
      { kind: "TaskSettingChanged", setting: { kind: "Disabled" } },
    ]);
    expect(getTaskSetting(store)()).toEqual(Result.succeed({ kind: "Disabled" }));
  });

  test("いまと同じ ToDo の設定にしても記録を変えず、何も知らせない", () => {
    const store = newStore();
    changeTaskSettingCommand(store)({ kind: "Enabled" });
    const before = store.currentRevision();

    const result = changeTaskSettingCommand(store)({ kind: "Enabled" });

    expect(result).toEqual(Result.succeed({ value: { kind: "Enabled" }, messages: [] }));
    expect(store.currentRevision()).toBe(before);
  });

  test("入力が不正なら失敗し、ToDo の設定は変わらない", () => {
    const store = newStore();

    const result = changeTaskSettingCommand(store)({ kind: "On" });

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
    expect(getTaskSetting(store)()).toEqual(Result.succeed({ kind: "Disabled" }));
  });
});

describe("ジャーナルからの完了の記録", () => {
  const entryId = v.parse(JournalEntryId.schema, uuid(50));
  const judgment = (n: number, probability: number): TaskJudgment => ({
    taskId: taskId(n),
    probability: v.parse(Probability.schema, probability),
  });

  test("判断モデルがしきい値以上と答えた未完了のタスクを完了にし、1件ずつ保存したタスクを知らせる", () => {
    const store = newStore();
    createdTask(store, 1, "ログイン画面のバグ修正");
    const notJudged = createdTask(store, 2, "牛乳を買う");
    createdTask(store, 3, "請求書を送る");
    const judgments = [judgment(1, 0.95), judgment(2, 0.5), judgment(3, 0.9)];

    const result = finishCompletionFromJournalCommand(store)(
      entryId,
      Result.succeed({ judgments, inputTokens: 120 }),
      later(60),
    );

    const completedAs = (n: number, title: string, probability: number) => ({
      kind: "Completed",
      id: uuid(n),
      title,
      createdAt: NOW,
      updatedAt: later(60),
      completedAt: later(60),
      completion: { kind: "FromJournal", entryId, probability },
    });
    const completed = [
      completedAs(1, "ログイン画面のバグ修正", 0.95),
      completedAs(3, "請求書を送る", 0.9),
    ];
    expect(result).toEqual({
      value: completed,
      messages: completed.map((task) => ({ kind: "TaskSaved", task })),
    });
    expect(tasksOf(store)).toEqual([completed[0], notJudged, completed[1]]);
    expect(store.taskJudgmentsOf(entryId)).toEqual(judgments);
    expect(store.decisionRunOf(entryId)).toEqual({ outcome: "Judged", inputTokens: 120 });
  });

  test("判断モデルが使えなかったら、タスクを変えず何も知らせず、使えなかったと記録する", () => {
    const store = newStore();
    const task = createdTask(store, 1, "ログイン画面のバグ修正");

    const result = finishCompletionFromJournalCommand(store)(
      entryId,
      Result.fail({ kind: "DecisionUnavailable", reason: "RequestFailed" }),
      later(60),
    );

    expect(result).toEqual({ value: [], messages: [] });
    expect(tasksOf(store)).toEqual([task]);
    expect(store.taskJudgmentsOf(entryId)).toBeUndefined();
    expect(store.decisionRunOf(entryId)).toEqual({ outcome: "Unavailable", inputTokens: 0 });
  });
});

// ---------------------------------------------------------------------------
// 取り込み
// ---------------------------------------------------------------------------

/** この端末で記録した日。アカウントの「いま」（NOW）より前 */
const DEVICE_DAY = NOW.getTime() - 24 * 60 * 60 * 1000;
const onDevice = (minutes: number) => new Date(DEVICE_DAY + minutes * 60_000);

/** この端末で `from` 分に始めて `to` 分に終えたセッション `n` */
const deviceSession = (n: number, from: number, to: number): ClosedSession => {
  const id = v.parse(SessionId.schema, uuid(n));
  const eventId = (k: number) => v.parse(SessionEventId.schema, uuid(n * 10 + k));
  return {
    id,
    events: [
      { kind: "Start", id: eventId(1), at: onDevice(from) },
      { kind: "End", id: eventId(2), at: onDevice(to) },
    ],
    entries: [
      {
        kind: "Written",
        entry: {
          id: v.parse(JournalEntryId.schema, uuid(n * 10 + 3)),
          sessionId: id,
          body: Sensitive.of("端末で書いた"),
          tags: [],
          writtenAt: onDevice(from + 1),
          updatedAt: onDevice(from + 1),
          writtenDuring: { kind: "Journal", round: 1, setNumber: 1 },
        },
      },
    ],
    endedAt: onDevice(to),
    endedBy: "End",
  };
};

/** 送る形（JSON の文字列にして戻したもの）の束 */
const batchJson = (batch: Batch): unknown => JSON.parse(JSON.stringify(ImportBatch.toJson(batch)));

const importBatch = (store: ReturnType<typeof newStore>, batch: Batch, now: Date = NOW) =>
  importSessionsCommand(store)(batchJson(batch), now);

describe("取り込み", () => {
  test("空のアカウントに取り込むと、記録を取り込んだことと、アカウントの進め方を端末のいまの進め方にしたことを知らせる", () => {
    const store = newStore();
    const session = deviceSession(100, 0, 30);

    const result = importBatch(store, {
      sessions: [session],
      advanceModeChanges: [{ at: onDevice(60), mode: MANUAL }],
    });

    expect(result).toEqual(
      Result.succeed({
        value: { outcomes: [{ sessionId: session.id, kind: "Imported" }] },
        messages: [{ kind: "RecordsImported" }, { kind: "AdvanceModeChanged", mode: MANUAL }],
      }),
    );
    expect(store.importedSessionIds()).toEqual([session.id]);
    expect(getAdvanceMode(store)(later(1))).toEqual(Result.succeed(MANUAL));
  });

  test("端末の進め方が既定のままなら、記録を取り込んだことだけを知らせる", () => {
    const store = newStore();

    const result = importBatch(store, {
      sessions: [deviceSession(100, 0, 30)],
      advanceModeChanges: [],
    });

    expect(Result.unwrap(result).messages).toEqual([{ kind: "RecordsImported" }]);
  });

  test("セッションの間に変えた進め方は、変えた時刻のまま取り込む", () => {
    const store = newStore();

    const result = importBatch(store, {
      sessions: [deviceSession(100, 0, 30)],
      advanceModeChanges: [{ at: onDevice(10), mode: MANUAL }],
    });

    expect(Result.unwrap(result).messages).toEqual([{ kind: "RecordsImported" }]);
    expect(store.loadAdvanceModeChanges()).toEqual([{ at: onDevice(10), mode: MANUAL }]);
  });

  test("取り込んだセッションをもう一度取り込むと、上書きせず何も知らせない", () => {
    const store = newStore();
    const session = deviceSession(100, 0, 30);
    const batch = { sessions: [session], advanceModeChanges: [{ at: onDevice(60), mode: MANUAL }] };
    importBatch(store, batch);
    const before = store.currentRevision();

    const result = importBatch(store, batch, later(60));

    expect(result).toEqual(
      Result.succeed({
        value: { outcomes: [{ sessionId: session.id, kind: "AlreadyImported" }] },
        messages: [],
      }),
    );
    expect(store.currentRevision()).toBe(before);
  });

  test("アカウントのセッションと時間が重なるセッションは取り込まず、何も知らせない", () => {
    const store = newStore();
    importBatch(store, { sessions: [deviceSession(100, 0, 30)], advanceModeChanges: [] });
    const overlapping = deviceSession(200, 20, 50);

    const result = importBatch(store, { sessions: [overlapping], advanceModeChanges: [] });

    expect(result).toEqual(
      Result.succeed({
        value: { outcomes: [{ sessionId: overlapping.id, kind: "Overlapping" }] },
        messages: [],
      }),
    );
    expect(store.importedSessionIds()).toEqual([uuid(100)]);
  });

  test("束の一部だけを取り込めても、記録を取り込んだことを知らせ、結果は束と同じ順に返す", () => {
    const store = newStore();
    const first = deviceSession(100, 0, 30);
    importBatch(store, { sessions: [first], advanceModeChanges: [] });
    const second = deviceSession(200, 60, 90);

    const result = importBatch(store, { sessions: [first, second], advanceModeChanges: [] });

    expect(result).toEqual(
      Result.succeed({
        value: {
          outcomes: [
            { sessionId: first.id, kind: "AlreadyImported" },
            { sessionId: second.id, kind: "Imported" },
          ],
        },
        messages: [{ kind: "RecordsImported" }],
      }),
    );
  });

  test("アカウントに自分の記録があれば、セッションの間だけ端末の進め方にし、アカウントのいまの進め方は変えない", () => {
    const store = startedStore();
    operateSessionCommand(store)({ id: uuid(2), kind: "End" }, later(1));
    const session = deviceSession(100, 0, 30);

    const result = importBatch(
      store,
      { sessions: [session], advanceModeChanges: [{ at: onDevice(-10), mode: MANUAL }] },
      later(60),
    );

    expect(Result.unwrap(result).messages).toEqual([{ kind: "RecordsImported" }]);
    expect(store.loadAdvanceModeChanges()).toEqual([
      { at: onDevice(0), mode: MANUAL },
      { at: new Date(onDevice(30).getTime() + 1), mode: ALL_AUTO },
    ]);
    expect(getAdvanceMode(store)(later(60))).toEqual(Result.succeed(ALL_AUTO));
  });

  test("束が不正なら失敗し、何も取り込まない", () => {
    const store = newStore();

    const result = importSessionsCommand(store)({ sessions: [], advanceModeChanges: [] }, NOW);

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
    expect(store.importedSessionIds()).toEqual([]);
  });
});
