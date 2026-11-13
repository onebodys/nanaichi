import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  AdvanceModeChange,
  AdvanceModeJsonSchema,
  type AdvanceMode,
} from "../domain/advance-mode.ts";
import { ImportBatch, ImportReceiptJsonSchema, type ImportReceipt } from "../domain/import.ts";
import { JournalEntryId } from "../domain/journal-entry.ts";
import { schemaResult } from "../domain/schema-result.ts";
import { Sensitive } from "../domain/sensitive.ts";
import { SessionEventId, type RecordedSessionEvents } from "../domain/session-event.ts";
import { SessionRecord, type ClosedSession, type StoredEntry } from "../domain/session-record.ts";
import { Session, SessionId } from "../domain/session.ts";
import { StatsReportJsonSchema } from "../domain/stats.ts";
import { TagName } from "../domain/tag.ts";
import { TimelinePageJsonSchema, type TimelinePage } from "../domain/timeline.ts";
import { prepareDatabase, request, resetStorage, signInAs } from "./workers-test-harness.ts";

// 時計の扱いは session-api.workers.test.ts と同じ。alarm がすぐ鳴らないよう、本当の時計より先の時刻でテストする。
// この端末の記録はアカウントの「いま」より前の日に記録したものとして作る
const NOW = Date.UTC(2100, 0, 10, 0, 0, 0);
const DEVICE_DAY = Date.UTC(2100, 0, 1, 0, 0, 0);
const at = (minutes: number) => new Date(DEVICE_DAY + minutes * 60_000);
const accountAt = (minutes: number) => NOW + minutes * 60_000;
const passTo = (ms: number) => vi.setSystemTime(ms);

const ORIGIN = "http://localhost:5173";

let headers: Headers;
let userId: string;
const opened: Array<WebSocket> = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  passTo(accountAt(0));
  await prepareDatabase();
  ({ headers, userId } = await signInAs("me@example.com"));
});

afterEach(async () => {
  for (const ws of opened.splice(0)) {
    ws.close();
  }
  vi.useRealTimers();
  await resetStorage();
});

const ALL_AUTO = {
  FocusToJournal: "Auto",
  JournalToFocus: "Auto",
  JournalToBreak: "Auto",
  BreakToFocus: "Auto",
} as const satisfies AdvanceMode;
const MANUAL = { ...ALL_AUTO, FocusToJournal: "Manual" } as const satisfies AdvanceMode;
const ALL_MANUAL = {
  FocusToJournal: "Manual",
  JournalToFocus: "Manual",
  JournalToBreak: "Manual",
  BreakToFocus: "Manual",
} as const satisfies AdvanceMode;

const withBody = (method: string, body: unknown, h: Headers = headers): RequestInit => ({
  method,
  headers: { cookie: h.get("cookie") ?? "", "content-type": "application/json" },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// この端末の記録（端末で記録したのと同じ形）
// ---------------------------------------------------------------------------

const uuid = () => crypto.randomUUID();
const eventId = () => v.parse(SessionEventId.schema, uuid());
const tag = (name: string) => v.parse(TagName.schema, name);

type EntrySpec = Readonly<{ minute: number; body?: string; tags?: ReadonlyArray<string> }>;

/** `from` 分に始めて `to` 分に終えたセッション。`AutoEnd` なら終わった時刻は最後の記入・操作の時刻 */
const deviceSession = (
  from: number,
  to: number,
  options: Readonly<{
    endedBy?: ClosedSession["endedBy"];
    written?: ReadonlyArray<EntrySpec>;
    deleted?: ReadonlyArray<number>;
    id?: SessionId;
    events?: RecordedSessionEvents;
  }> = {},
): ClosedSession => {
  const id = options.id ?? v.parse(SessionId.schema, uuid());
  const endedBy = options.endedBy ?? "End";
  const startEvent = { kind: "Start", id: eventId(), at: at(from) } as const;
  const events: RecordedSessionEvents =
    options.events ??
    (endedBy === "End" ? [startEvent, { kind: "End", id: eventId(), at: at(to) }] : [startEvent]);
  const written = (options.written ?? []).map((spec): StoredEntry => ({
    kind: "Written",
    entry: {
      id: v.parse(JournalEntryId.schema, uuid()),
      sessionId: id,
      body: Sensitive.of(spec.body ?? "端末で書いた"),
      tags: (spec.tags ?? []).map(tag),
      writtenAt: at(spec.minute),
      updatedAt: at(spec.minute),
      writtenDuring: { kind: "Journal", round: 1, setNumber: 1 },
    },
  }));
  const deleted = (options.deleted ?? []).map((minute): StoredEntry => ({
    kind: "Deleted",
    deleted: { id: v.parse(JournalEntryId.schema, uuid()), deletedAt: at(minute + 1) },
    sessionId: id,
    writtenAt: at(minute),
  }));
  return { id, events, entries: [...written, ...deleted], endedAt: at(to), endedBy };
};

/** 時刻（ミリ秒）で指定した、終了したセッション */
const sessionBetween = (fromMs: number, toMs: number): ClosedSession => ({
  ...deviceSession(0, 0, {
    events: [
      { kind: "Start", id: eventId(), at: new Date(fromMs) },
      { kind: "End", id: eventId(), at: new Date(toMs) },
    ],
  }),
  endedAt: new Date(toMs),
});

const completedSetsOf = (session: Session, now: Date): number =>
  Session.setOutcomesAt(session, now).filter(({ kind }) => kind === "CompletedSet").length;

/** この端末が閉じたセッションを計算するのと同じ形（records.ts）。進め方は終わった時刻までを読む */
const computedOnDevice = (
  session: ClosedSession,
  device: ReadonlyArray<AdvanceModeChange>,
): Session => ({
  id: session.id,
  events: session.events,
  journalEntryTimes: session.entries
    .map((stored) => (stored.kind === "Written" ? stored.entry.writtenAt : stored.writtenAt))
    .toSorted((a, b) => a.getTime() - b.getTime()),
  advanceModeChanges: AdvanceModeChange.relevantSince(device, session.events[0].at).filter(
    (change) => change.at.getTime() <= session.endedAt.getTime(),
  ),
});

/** 端末で自動終了したセッション。終わった時刻は端末で計算した自動終了の時刻 */
const autoEndedOnDevice = (
  from: number,
  device: ReadonlyArray<AdvanceModeChange>,
  written: ReadonlyArray<EntrySpec> = [],
): ClosedSession => {
  const open = deviceSession(from, from + 10_000, { endedBy: "AutoEnd", written });
  const state = Session.stateAt(computedOnDevice(open, device), at(from + 10_000));
  if (state.kind !== "Ended") {
    throw new Error("自動終了していない");
  }
  return { ...open, endedAt: state.endedAt };
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const sendBatch = (
  sessions: ReadonlyArray<ClosedSession>,
  advanceModeChanges: ReadonlyArray<AdvanceModeChange> = [],
  h: Headers = headers,
) =>
  request(
    "/api/imports",
    withBody("POST", ImportBatch.toJson({ sessions, advanceModeChanges }), h),
  );

/** 応答が画面と同じスキーマに合うことを確かめてから返す（ADR 0009） */
const receiptOf = async (res: Response): Promise<ImportReceipt> => {
  expect(res.status).toBe(200);
  const parsed = schemaResult(ImportReceiptJsonSchema)(await res.json());
  if (Result.isFailure(parsed)) {
    throw new Error("応答がスキーマに合わない");
  }
  return parsed.value;
};

const importBatch = async (
  sessions: ReadonlyArray<ClosedSession>,
  advanceModeChanges: ReadonlyArray<AdvanceModeChange> = [],
) => receiptOf(await sendBatch(sessions, advanceModeChanges));

const kindsOf = (receipt: ImportReceipt) => receipt.outcomes.map(({ kind }) => kind);

const timeline = async (): Promise<TimelinePage> => {
  const parsed = schemaResult(TimelinePageJsonSchema)(
    await (await request("/api/timeline", { headers })).json(),
  );
  if (Result.isFailure(parsed)) {
    throw new Error("タイムラインの応答がスキーマに合わない");
  }
  return parsed.value;
};

const timelineSession = async (id: SessionId) => {
  const found = (await timeline()).sessions.find(({ session }) => session.id === id);
  if (found === undefined) {
    throw new Error("タイムラインにセッションがない");
  }
  return found;
};

const completedSetsInStats = async (): Promise<number> => {
  const parsed = schemaResult(StatsReportJsonSchema)(
    await (await request("/api/stats?period=All&timeZone=UTC", { headers })).json(),
  );
  if (Result.isFailure(parsed)) {
    throw new Error("スタッツの応答がスキーマに合わない");
  }
  const { activity } = parsed.value;
  return activity.kind === "Active" ? activity.completedSets : 0;
};

const currentMode = async (): Promise<AdvanceMode> => {
  const parsed = schemaResult(AdvanceModeJsonSchema)(
    await (await request("/api/settings/advance-mode", { headers })).json(),
  );
  if (Result.isFailure(parsed)) {
    throw new Error("進め方の応答がスキーマに合わない");
  }
  return parsed.value;
};

const putMode = (mode: AdvanceMode) => request("/api/settings/advance-mode", withBody("PUT", mode));
const startAccountSession = () => request("/api/session", withBody("POST", { id: uuid() }));
const operate = (kind: string) =>
  request("/api/session/commands", withBody("POST", { id: uuid(), kind }));
const write = (body: string, tags: ReadonlyArray<string> = []) =>
  request("/api/journal-entries", withBody("POST", { id: uuid(), body, tags }));

/** アカウントで `from` 分に始めて `to` 分に終えたセッション（いまの時計で記録する） */
const accountSession = async (from: number, to: number) => {
  passTo(accountAt(from));
  expect((await startAccountSession()).status).toBe(200);
  passTo(accountAt(to));
  expect((await operate("End")).status).toBe(200);
};

const connect = async () => {
  const res = await request("/api/ws", {
    headers: { cookie: headers.get("cookie") ?? "", upgrade: "websocket", origin: ORIGIN },
  });
  const ws = res.webSocket;
  if (ws === null) {
    throw new Error("WebSocket が返ってこなかった");
  }
  ws.accept();
  opened.push(ws);
  const received: Array<unknown> = [];
  ws.addEventListener("message", (event) => {
    received.push(typeof event.data === "string" ? JSON.parse(event.data) : "(binary)");
  });
  return received;
};

const advanceModeRows = () =>
  runInDurableObject(env.USER_DO.getByName(userId), (_, state) =>
    state.storage.sql
      .exec<{ changed_at: number; origin: string }>(
        "SELECT changed_at, origin FROM advance_mode_changes ORDER BY changed_at, rowid",
      )
      .toArray(),
  );

/** 計算した結果で比べる。`advanceModeChanges` の時刻は、同じ値の行が別の時刻にあっても計算は変わらない */
const statesOf = (session: Session, times: ReadonlyArray<Date>) =>
  times.map((time) => Session.stateAt(session, time));

// ---------------------------------------------------------------------------

describe("ログインしていないとき", () => {
  test("取り込みは 401 になる", async () => {
    const res = await request("/api/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        ImportBatch.toJson({ sessions: [deviceSession(0, 30)], advanceModeChanges: [] }),
      ),
    });

    expect(res.status).toBe(401);
  });
});

describe("取り込み", () => {
  test("空のアカウントに取り込むと、タイムラインとスタッツに取り込んだセッションと記入が出る", async () => {
    // 自動の進め方で 10 分続けると、1セット目の集中（7分）とジャーナル（1分）が終わって完了セットになる
    const first = deviceSession(0, 10, {
      written: [{ minute: 7, body: "1つ目の記入", tags: ["読書"] }],
    });
    const second = deviceSession(60, 70, { written: [{ minute: 67, body: "2つ目の記入" }] });

    const receipt = await importBatch([first, second]);

    expect(receipt.outcomes).toEqual([
      { sessionId: first.id, kind: "Imported" },
      { sessionId: second.id, kind: "Imported" },
    ]);
    const page = await timeline();
    expect(page.sessions.map(({ session }) => session.id)).toEqual([second.id, first.id]);
    expect(
      page.sessions.flatMap(({ entries }) => entries.map((entry) => entry.body.unwrap())),
    ).toEqual(["2つ目の記入", "1つ目の記入"]);
    expect(await completedSetsInStats()).toBe(2);
    expect(await (await request("/api/tags", { headers })).json()).toEqual({ tags: ["読書"] });
  });

  test("同じ束をもう一度送ると、すべて AlreadyImported になり何も書き換えない", async () => {
    const session = deviceSession(0, 10, { written: [{ minute: 7, body: "最初に送った本文" }] });
    await importBatch([session]);
    const before = await timeline();

    const rewritten: ClosedSession = {
      ...session,
      entries: session.entries.map((stored) =>
        stored.kind === "Written"
          ? { ...stored, entry: { ...stored.entry, body: Sensitive.of("送り直しで変えた本文") } }
          : stored,
      ),
    };
    const receipt = await importBatch([rewritten]);

    expect(kindsOf(receipt)).toEqual(["AlreadyImported"]);
    const after = await timeline();
    expect(
      after.sessions.flatMap(({ entries }) => entries.map((entry) => entry.body.unwrap())),
    ).toEqual(["最初に送った本文"]);
    expect(after.sessions.map(({ session: s }) => s)).toEqual(
      before.sessions.map(({ session: s }) => s),
    );
  });

  test("削除した記入は取り込んでもタイムラインに出ないが、自動終了の判断には数える", async () => {
    const session = deviceSession(0, 30, {
      written: [{ minute: 5, body: "残した記入" }],
      deleted: [20],
    });

    await importBatch([session]);

    const { entries, session: loaded } = await timelineSession(session.id);
    expect(entries.map((entry) => entry.body.unwrap())).toEqual(["残した記入"]);
    expect(loaded.journalEntryTimes).toEqual([at(5), at(20)]);
  });

  test("開いているセッションを含む束は 400 になり、何も書かない", async () => {
    const closed = deviceSession(0, 10);
    const open = deviceSession(20, 30);
    const body = {
      sessions: [
        SessionRecord.toJson({ kind: "Closed", session: closed }),
        SessionRecord.toJson({ kind: "Open", session: open }),
      ],
      advanceModeChanges: [],
    };

    const res = await request("/api/imports", withBody("POST", body));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVALID_REQUEST" });
    expect((await timeline()).sessions).toEqual([]);
  });

  test("束の途中のセッションで ID が衝突したら、束のどのセッションも書かない", async () => {
    const first = deviceSession(0, 10);
    await importBatch([first]);
    const fresh = deviceSession(60, 70);
    // 別のセッションなのに、取り込み済みのセッションと同じ操作イベントの ID を持つ（壊れた記録）
    const colliding = deviceSession(120, 130, {
      events: [
        { kind: "Start", id: first.events[0].id, at: at(120) },
        { kind: "End", id: eventId(), at: at(130) },
      ],
    });

    const res = await sendBatch([fresh, colliding]);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await timeline()).sessions.map(({ session }) => session.id)).toEqual([first.id]);
  });

  test("取り込むと、ほかの接続に RecordsImported が届き、送り直しでは届かない", async () => {
    const received = await connect();
    const session = deviceSession(0, 10);

    await importBatch([session]);
    await vi.waitFor(() => expect(received).toContainEqual({ kind: "RecordsImported" }));
    received.splice(0);
    await importBatch([session]);
    await importBatch([deviceSession(60, 70)]);

    await vi.waitFor(() => expect(received).toContainEqual({ kind: "RecordsImported" }));
    expect(
      received.filter((message) => JSON.stringify(message).includes("RecordsImported")),
    ).toHaveLength(1);
  });

  test("本文が JSON でない取り込みは 400 になる", async () => {
    const res = await request("/api/imports", {
      method: "POST",
      headers: { cookie: headers.get("cookie") ?? "", "content-type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
  });
});

describe("時間が重なるセッション", () => {
  test("アカウントのセッションと時間が重なるセッションは Overlapping になり、書かない", async () => {
    await accountSession(0, 30);
    const receipt = await importBatch([sessionBetween(accountAt(20), accountAt(40))]);

    expect(kindsOf(receipt)).toEqual(["Overlapping"]);
    expect((await timeline()).sessions).toHaveLength(1);
  });

  test("アカウントのセッションが終わった時刻に始めたセッションは重なるとみなし、1ミリ秒後なら取り込める", async () => {
    await accountSession(0, 30);
    const touching = sessionBetween(accountAt(30), accountAt(40));
    const after = sessionBetween(accountAt(30) + 1, accountAt(40));
    const beforeTouching = sessionBetween(accountAt(-10), accountAt(0));

    const receipt = await importBatch([beforeTouching, touching, after]);

    expect(kindsOf(receipt)).toEqual(["Overlapping", "Overlapping", "Imported"]);
  });

  test("アカウントで開いているセッションと時間が重なるセッションは Overlapping になる", async () => {
    passTo(accountAt(0));
    await startAccountSession();
    const receipt = await importBatch([
      sessionBetween(accountAt(-5), accountAt(1)),
      deviceSession(0, 10),
    ]);

    expect(kindsOf(receipt)).toEqual(["Overlapping", "Imported"]);
  });

  test("同じ束のセッションどうしが重なれば、後のセッションは Overlapping になる", async () => {
    const receipt = await importBatch([deviceSession(0, 30), deviceSession(20, 40)]);

    expect(kindsOf(receipt)).toEqual(["Imported", "Overlapping"]);
  });
});

describe("フェーズの進め方", () => {
  test("空のアカウントに取り込むと、アカウントのいまの進め方が端末のいまの進め方になる", async () => {
    const received = await connect();
    const device = [
      { at: at(-100), mode: MANUAL },
      { at: at(500), mode: ALL_MANUAL },
    ];

    await importBatch([deviceSession(0, 10)], device);

    expect(await currentMode()).toEqual(ALL_MANUAL);
    await vi.waitFor(() =>
      expect(received).toContainEqual({ kind: "AdvanceModeChanged", mode: ALL_MANUAL }),
    );
  });

  test("取り込み以外の記録があるアカウントでは、いまの進め方は変わらない", async () => {
    await accountSession(0, 10);

    await importBatch([deviceSession(0, 10)], [{ at: at(-100), mode: ALL_MANUAL }]);

    expect(await currentMode()).toEqual(ALL_AUTO);
  });

  test("束を2回に分けても、2回目の束で進め方の判断が変わらない", async () => {
    const device = [
      { at: at(-100), mode: MANUAL },
      { at: at(100), mode: ALL_MANUAL },
    ];
    const first = deviceSession(0, 10);
    const second = deviceSession(200, 210);

    await importBatch([first], device);
    const afterFirst = await advanceModeRows();
    await importBatch([second], device);
    // やり直しても同じ
    await importBatch([first, second], device);

    expect(await currentMode()).toEqual(ALL_MANUAL);
    // 2回目の束も取り込みだけのアカウントとして扱うので、戻す行を足さない（足した行はすべて取り込みの印つき）
    const rows = await advanceModeRows();
    // 1回目: 始めた時刻の行といまの進め方の行。2回目: 始めた時刻の行だけ（終わった時刻の直後に戻す行はない）
    expect(afterFirst.map(({ changed_at }) => changed_at)).toEqual([at(0).getTime(), NOW]);
    expect(rows.map(({ changed_at }) => changed_at)).toEqual([
      at(0).getTime(),
      at(200).getTime(),
      NOW,
    ]);
    expect(rows.every(({ origin }) => origin === "Import")).toBe(true);
    const loaded = await timelineSession(second.id);
    const times = [at(205), at(209)];
    expect(statesOf(loaded.session, times)).toEqual(
      statesOf(computedOnDevice(second, device), times),
    );
  });

  test("取り込んでも、アカウントの過去のセッションの計算は変わらない", async () => {
    // アカウント: 手動にしてからセッション、自動に戻してからもう1つ
    passTo(accountAt(-30));
    await putMode(MANUAL);
    await accountSession(0, 20);
    passTo(accountAt(30));
    await putMode(ALL_AUTO);
    await accountSession(60, 80);
    const before = await timeline();
    const statsBefore = await completedSetsInStats();

    // 端末: アカウントのセッションの前・間・後に、違う進め方で記録したセッション
    const device = [
      { at: new Date(accountAt(-1000)), mode: ALL_MANUAL },
      { at: new Date(accountAt(45)), mode: MANUAL },
    ];
    const deviceAt = (from: number, to: number) => sessionBetween(accountAt(from), accountAt(to));
    const imported = [deviceAt(-200, -180), deviceAt(40, 50), deviceAt(100, 110)];
    passTo(accountAt(200));

    const receipt = await importBatch(imported, device);

    expect(kindsOf(receipt)).toEqual(["Imported", "Imported", "Imported"]);
    const after = await timeline();
    for (const { session } of before.sessions) {
      const reloaded = after.sessions.find((s) => s.session.id === session.id);
      const times = [0, 7, 8, 10, 15, 20, 60, 67, 75, 80].map((m) => new Date(accountAt(m)));
      expect(reloaded && statesOf(reloaded.session, times)).toEqual(statesOf(session, times));
    }
    for (const session of imported) {
      const loaded = after.sessions.find((s) => s.session.id === session.id);
      const times = [0, 5, 7, 8, 9, 10].map(
        (m) => new Date(session.events[0].at.getTime() + m * 60_000),
      );
      expect(loaded && statesOf(loaded.session, times)).toEqual(
        statesOf(computedOnDevice(session, device), times),
      );
    }
    const importedSets = imported.reduce(
      (sum, session) =>
        sum + completedSetsOf(computedOnDevice(session, device), new Date(accountAt(1000))),
      0,
    );
    expect(importedSets).toBeGreaterThan(0);
    expect(await completedSetsInStats()).toBe(statsBefore + importedSets);
    expect(await currentMode()).toEqual(ALL_AUTO);
  });

  test("自動終了したセッションは、取り込み以外の記録があるアカウントでも端末で計算したものと同じになる", async () => {
    await accountSession(0, 10);
    const device = [
      { at: at(-100), mode: MANUAL },
      { at: at(3), mode: ALL_MANUAL },
    ];
    const session = autoEndedOnDevice(0, device, [{ minute: 12 }]);
    passTo(accountAt(100));

    expect(kindsOf(await importBatch([session], device))).toEqual(["Imported"]);

    const loaded = await timelineSession(session.id);
    const onDevice = computedOnDevice(session, device);
    const times = [0, 3, 7, 8, 12, 30, 69, 70, 71, 200].map(at);
    expect(statesOf(loaded.session, times)).toEqual(statesOf(onDevice, times));
    expect(Session.stateAt(loaded.session, at(10_000))).toMatchObject({
      kind: "Ended",
      endedBy: "AutoEnd",
      endedAt: session.endedAt,
    });
    // 戻す行は終わった時刻の 1 ミリ秒後にあり、スタッツの計算にも入らない（スタッツは閉じた時刻までを読む）
    const rows = await advanceModeRows();
    expect(rows.map(({ changed_at }) => changed_at)).toContain(session.endedAt.getTime() + 1);
    // アカウントのセッション（自動で10分）は1セット
    expect(await completedSetsInStats()).toBe(completedSetsOf(onDevice, at(10_000)) + 1);
  });
});

describe("自動終了したアカウントのセッションのあとに取り込む", () => {
  test("最後の操作から自動終了までの間に始めたセッションを取り込んでも、アカウントのセッションのスタッツは変わらない", async () => {
    // アカウント: 始めたまま放っておき、自動終了させる（閉じた時刻は最後の操作 = 始めた時刻）
    passTo(accountAt(0));
    await startAccountSession();
    passTo(accountAt(200));
    await request("/api/session/current", { headers });
    const statsBefore = await completedSetsInStats();
    // 端末: アカウントのセッションの閉じた時刻のあと、自動終了の時刻より前に、違う進め方で記録した
    const device = [{ at: new Date(accountAt(-1000)), mode: ALL_MANUAL }];
    const session = sessionBetween(accountAt(30), accountAt(40));

    expect(kindsOf(await importBatch([session], device))).toEqual(["Imported"]);

    expect(await completedSetsInStats()).toBe(
      statsBefore + completedSetsOf(computedOnDevice(session, device), new Date(accountAt(200))),
    );
  });
});

describe("タグ", () => {
  test("タグが合わせて20種類を超えても取り込め、そのあと使っているタグだけの記入は書ける", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `tag${i + 1}`);
    const session = deviceSession(0, 30, {
      written: names.map((name, i) => ({ minute: 1 + i, tags: [name] })),
    });

    expect(kindsOf(await importBatch([session]))).toEqual(["Imported"]);

    passTo(accountAt(0));
    await startAccountSession();
    passTo(accountAt(1));
    expect((await write("タグなし")).status).toBe(200);
    expect((await write("使っているタグ", ["tag3", "tag25"])).status).toBe(200);
    const rejected = await write("新しいタグ", ["新しい"]);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: "TAG_LIMIT_EXCEEDED" });
  });

  test("上限を超えたアカウントで、その記入にしかないタグをつけた記入の本文を書き直せる", async () => {
    const names = Array.from({ length: 21 }, (_, i) => `tag${i + 1}`);
    const session = deviceSession(0, 30, {
      written: names.map((name, i) => ({ minute: 1 + i, tags: [name] })),
    });
    await importBatch([session]);
    const only = session.entries[0];
    if (only?.kind !== "Written") {
      throw new Error("記入がない");
    }

    const res = await request(
      `/api/journal-entries/${only.entry.id}`,
      withBody("PATCH", { body: "書き直した", tags: ["tag1"] }),
    );

    expect(res.status).toBe(200);
  });
});

describe("マイグレーション", () => {
  test("アカウントで記録したセッションと進め方の変更は、取り込みの印のない行になる", async () => {
    await putMode(MANUAL);
    await accountSession(0, 10);

    const origins = await runInDurableObject(env.USER_DO.getByName(userId), (_, state) => [
      ...state.storage.sql.exec<{ origin: string }>("SELECT origin FROM sessions").toArray(),
      ...state.storage.sql
        .exec<{ origin: string }>("SELECT origin FROM advance_mode_changes")
        .toArray(),
    ]);

    expect(origins).toEqual([{ origin: "Account" }, { origin: "Account" }]);
  });
});
