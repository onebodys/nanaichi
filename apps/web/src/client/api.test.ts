import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { AdvanceMode } from "../domain/advance-mode.ts";
import { SessionEventId } from "../domain/session-event.ts";
import { JournalCalendar } from "../domain/journal-calendar.ts";
import { JournalEntry, JournalEntryBody, JournalEntryId } from "../domain/journal-entry.ts";
import { Session, SessionId, type SessionSnapshot } from "../domain/session.ts";
import { Stats } from "../domain/stats.ts";
import { TagName } from "../domain/tag.ts";
import { TaggedEntries } from "../domain/tagged-entries.ts";
import { Timeline } from "../domain/timeline.ts";
import { createApiClient } from "./api.ts";

const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
const at = (minutes: number) => new Date(STARTED_AT + minutes * 60_000);

const started = Session.start(
  v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000000"),
  v.parse(SessionEventId.schema, "00000000-0000-4000-8000-000000000001"),
  at(0),
  [],
);

/** サーバーと同じく、本文を JSON にして返す fetch。呼ばれたパスとリクエストを記録する */
const respondWith = (status: number, body: unknown) => {
  const paths: Array<string> = [];
  const requests: Array<RequestInit | undefined> = [];
  const fetchApi = async (path: string, init?: RequestInit) => {
    paths.push(path);
    requests.push(init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { client: createApiClient(fetchApi), paths, requests };
};

describe("現在のセッションの取得", () => {
  test("GET /api/session/current を呼ぶ", async () => {
    const { client, paths } = respondWith(200, { kind: "NoSession", serverTime: at(0) });

    await client.getCurrentSession();

    expect(paths).toEqual(["/api/session/current"]);
  });

  test("セッションがなければ、セッションなしのスナップショットを時刻を Date に戻して返す", async () => {
    const snapshot: SessionSnapshot = { kind: "NoSession", serverTime: at(0) };
    const { client } = respondWith(200, snapshot);

    expect(await client.getCurrentSession()).toEqual(Result.succeed(snapshot));
  });

  test("セッション中なら、操作イベントとタイマーの状態を含むスナップショットを返す", async () => {
    const snapshot = Session.snapshot(started, at(3));
    const { client } = respondWith(200, snapshot);

    const result = await client.getCurrentSession();

    expect(result).toEqual(Result.succeed(snapshot));
    expect(
      Result.isSuccess(result) && result.value.kind === "Session" && result.value.state,
    ).toMatchObject({
      kind: "Focus",
      remainingSeconds: 4 * 60,
    });
  });

  test("ログインしていなければ、UNAUTHENTICATED の ApiRejected を返す", async () => {
    const { client } = respondWith(401, { error: "UNAUTHENTICATED" });

    expect(await client.getCurrentSession()).toEqual(
      Result.fail({ kind: "ApiRejected", status: 401, code: "UNAUTHENTICATED" }),
    );
  });

  test("応答がスナップショットのスキーマに合わなければ UnexpectedResponse を返す", async () => {
    const { client } = respondWith(200, { kind: "Session", serverTime: at(0) });

    expect(await client.getCurrentSession()).toEqual(
      Result.fail({ kind: "UnexpectedResponse", status: 200 }),
    );
  });

  test("知らない種類のエラーの応答は UnexpectedResponse を返す", async () => {
    const { client } = respondWith(500, { message: "Internal Server Error" });

    expect(await client.getCurrentSession()).toEqual(
      Result.fail({ kind: "UnexpectedResponse", status: 500 }),
    );
  });

  test("応答が JSON でなければ UnexpectedResponse を返す", async () => {
    const client = createApiClient(async () => new Response("<!doctype html>", { status: 200 }));

    expect(await client.getCurrentSession()).toEqual(
      Result.fail({ kind: "UnexpectedResponse", status: 200 }),
    );
  });

  test("通信できなければ NetworkError を返す", async () => {
    const client = createApiClient(async () => {
      throw new TypeError("Failed to fetch");
    });

    expect(await client.getCurrentSession()).toEqual(Result.fail({ kind: "NetworkError" }));
  });
});

const operationId = v.parse(SessionEventId.schema, "00000000-0000-4000-8000-000000000002");

describe("セッションの開始", () => {
  test("開始の操作イベントの ID を本文に入れて POST /api/session を呼ぶ", async () => {
    const { client, paths, requests } = respondWith(200, Session.snapshot(started, at(0)));

    await client.startSession(operationId);

    expect(paths).toEqual(["/api/session"]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ id: operationId }),
    });
  });

  test("開始したセッションのスナップショットを返す", async () => {
    const snapshot = Session.snapshot(started, at(0));
    const { client } = respondWith(200, snapshot);

    expect(await client.startSession(operationId)).toEqual(Result.succeed(snapshot));
  });

  test("セッション中に開始すると、SESSION_ALREADY_IN_PROGRESS の ApiRejected を返す", async () => {
    const { client } = respondWith(409, { error: "SESSION_ALREADY_IN_PROGRESS" });

    expect(await client.startSession(operationId)).toEqual(
      Result.fail({ kind: "ApiRejected", status: 409, code: "SESSION_ALREADY_IN_PROGRESS" }),
    );
  });
});

describe("セッションへの操作", () => {
  test("操作イベントの ID と操作の種類を本文に入れて POST /api/session/commands を呼ぶ", async () => {
    const { client, paths, requests } = respondWith(200, Session.snapshot(started, at(1)));

    await client.operateSession(operationId, "Pause");

    expect(paths).toEqual(["/api/session/commands"]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ id: operationId, kind: "Pause" }),
    });
  });

  test("その状態ではできない操作なら、OPERATION_REJECTED の ApiRejected を返す", async () => {
    const { client } = respondWith(409, {
      error: "OPERATION_REJECTED",
      operation: "SkipBreak",
      during: "Focus",
    });

    expect(await client.operateSession(operationId, "SkipBreak")).toEqual(
      Result.fail({ kind: "ApiRejected", status: 409, code: "OPERATION_REJECTED" }),
    );
  });
});

const entryId = v.parse(JournalEntryId.schema, "00000000-0000-4000-8000-0000000000e1");

const readingTag = v.parse(TagName.schema, "読書");

const written = (() => {
  const result = JournalEntry.write({
    id: entryId,
    body: v.parse(JournalEntryBody.schema, "メモ"),
    tags: [readingTag],
    sessionId: started.id,
    state: Session.stateAt(started, at(3)),
    now: at(3),
  });
  if (Result.isFailure(result)) throw new Error("書けなかった");
  return result.value;
})();

/** 本文は `Sensitive` なので、比べるときは取り出した形にする */
/** 2026-10-17（`STARTED_AT` の日付） */
const calendarDate = () =>
  JournalCalendar.of({
    month: { year: 2026, month: 10 },
    writtenAts: [],
    now: at(0),
    timeZone: "Asia/Tokyo",
  }).today;

const unwrapped = (result: Result.Result<JournalEntry, unknown>) =>
  Result.isSuccess(result) ? JournalEntry.toJson(result.value) : result;

describe("ジャーナル記入", () => {
  test("記入の ID と本文とタグを本文に入れて POST /api/journal-entries を呼び、書いた記入を返す", async () => {
    const { client, paths, requests } = respondWith(200, JournalEntry.toJson(written));

    const result = await client.writeJournalEntry(entryId, "メモ", [readingTag]);

    expect(paths).toEqual(["/api/journal-entries"]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ id: entryId, body: "メモ", tags: ["読書"] }),
    });
    expect(unwrapped(result)).toEqual(JournalEntry.toJson(written));
  });

  test("セッションの外で書くと、NO_SESSION_IN_PROGRESS の ApiRejected を返す", async () => {
    const { client } = respondWith(409, { error: "NO_SESSION_IN_PROGRESS" });

    expect(await client.writeJournalEntry(entryId, "メモ", [])).toEqual(
      Result.fail({ kind: "ApiRejected", status: 409, code: "NO_SESSION_IN_PROGRESS" }),
    );
  });

  test("使えるタグの種類の上限を超えると、TAG_LIMIT_EXCEEDED の ApiRejected を返す", async () => {
    const { client } = respondWith(409, { error: "TAG_LIMIT_EXCEEDED", limit: 20 });

    expect(await client.writeJournalEntry(entryId, "メモ", [readingTag])).toEqual(
      Result.fail({ kind: "ApiRejected", status: 409, code: "TAG_LIMIT_EXCEEDED" }),
    );
  });

  test("編集は PATCH /api/journal-entries/:id を呼び、書き直した記入を返す", async () => {
    const edited = JournalEntry.edit(
      written,
      { body: v.parse(JournalEntryBody.schema, "直した"), tags: [] },
      at(9),
    );
    const { client, paths, requests } = respondWith(200, JournalEntry.toJson(edited));

    const result = await client.editJournalEntry(entryId, "直した", []);

    expect(paths).toEqual([`/api/journal-entries/${entryId}`]);
    expect(requests[0]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ body: "直した", tags: [] }),
    });
    expect(unwrapped(result)).toEqual(JournalEntry.toJson(edited));
  });

  test("削除は DELETE /api/journal-entries/:id を呼び、削除した時刻を返す", async () => {
    const { client, paths, requests } = respondWith(200, { id: entryId, deletedAt: at(9) });

    const result = await client.deleteJournalEntry(entryId);

    expect(paths).toEqual([`/api/journal-entries/${entryId}`]);
    expect(requests[0]).toMatchObject({ method: "DELETE" });
    expect(result).toEqual(Result.succeed({ id: entryId, deletedAt: at(9) }));
  });

  test("記入が見つからなければ、JOURNAL_ENTRY_NOT_FOUND の ApiRejected を返す", async () => {
    const { client } = respondWith(404, { error: "JOURNAL_ENTRY_NOT_FOUND" });

    expect(await client.deleteJournalEntry(entryId)).toEqual(
      Result.fail({ kind: "ApiRejected", status: 404, code: "JOURNAL_ENTRY_NOT_FOUND" }),
    );
  });
});

describe("タイムライン", () => {
  const page = Timeline.page([{ session: started, entries: [written] }], 10, at(5));

  test("before を省けば GET /api/timeline を呼ぶ", async () => {
    const { client, paths } = respondWith(200, Timeline.toJson(page));

    await client.getTimeline();

    expect(paths).toEqual(["/api/timeline"]);
  });

  test("before を渡すと ISO 8601 の時刻をクエリに入れる", async () => {
    const { client, paths } = respondWith(200, Timeline.toJson(page));

    await client.getTimeline(at(0));

    expect(paths).toEqual([`/api/timeline?before=${encodeURIComponent(at(0).toISOString())}`]);
  });

  test("ページを検証し、時刻を Date に戻して返す", async () => {
    const { client } = respondWith(200, Timeline.toJson(page));

    const result = await client.getTimeline();

    expect(Result.isSuccess(result) && Timeline.toJson(result.value)).toEqual(
      Timeline.toJson(page),
    );
  });

  test("応答がページのスキーマに合わなければ UnexpectedResponse を返す", async () => {
    const { client } = respondWith(200, { sessions: [] });

    expect(await client.getTimeline()).toEqual(
      Result.fail({ kind: "UnexpectedResponse", status: 200 }),
    );
  });
});

describe("タグ", () => {
  test("GET /api/tags を呼び、使っているタグを最近使った順のまま返す", async () => {
    const { client, paths } = respondWith(200, { tags: ["読書", "設計"] });

    const result = await client.getTags();

    expect(paths).toEqual(["/api/tags"]);
    expect(result).toEqual(Result.succeed({ tags: ["読書", "設計"] }));
  });

  test("応答のタグが名前の規則に合わなければ UnexpectedResponse を返す", async () => {
    const { client } = respondWith(200, { tags: ["空白 を含む"] });

    expect(await client.getTags()).toEqual(
      Result.fail({ kind: "UnexpectedResponse", status: 200 }),
    );
  });
});

describe("スタッツ", () => {
  const report = Stats.of({
    records: { sessions: [started], entries: [] },
    period: "Week",
    now: at(30),
    timeZone: "Asia/Tokyo",
  });

  test("GET /api/stats に期間と端末のタイムゾーンを渡す", async () => {
    const { client, paths } = respondWith(200, report);

    await client.getStats("Week", "Asia/Tokyo");

    expect(paths).toEqual(["/api/stats?period=Week&timeZone=Asia%2FTokyo"]);
  });

  test("スタッツを、時刻を Date に戻して返す", async () => {
    const { client } = respondWith(200, report);

    expect(await client.getStats("Week", "Asia/Tokyo")).toEqual(Result.succeed(report));
  });

  test("応答がスキーマに合わなければ UnexpectedResponse を返す", async () => {
    const { client } = respondWith(200, { ...report, period: "Year" });

    expect(await client.getStats("Week", "Asia/Tokyo")).toEqual(
      Result.fail({ kind: "UnexpectedResponse", status: 200 }),
    );
  });
});

describe("ジャーナルのカレンダー", () => {
  const calendar = JournalCalendar.of({
    month: { year: 2026, month: 10 },
    writtenAts: [at(10)],
    now: at(30),
    timeZone: "Asia/Tokyo",
  });

  test("GET /api/journal-calendar に月と端末のタイムゾーンを渡し、カレンダーを返す", async () => {
    const { client, paths } = respondWith(200, calendar);

    expect(await client.getJournalCalendar({ year: 2026, month: 10 }, "Asia/Tokyo")).toEqual(
      Result.succeed(calendar),
    );
    expect(paths).toEqual(["/api/journal-calendar?month=2026-10&timeZone=Asia%2FTokyo"]);
  });

  test("応答がスキーマに合わなければ UnexpectedResponse を返す", async () => {
    const { client } = respondWith(200, { ...calendar, days: [{ kind: "Day" }] });

    expect(await client.getJournalCalendar({ year: 2026, month: 10 }, "Asia/Tokyo")).toEqual(
      Result.fail({ kind: "UnexpectedResponse", status: 200 }),
    );
  });
});

describe("選んだ日の記入", () => {
  test("GET /api/journal-entries/by-date に日付と端末のタイムゾーンを渡し、記入を返す", async () => {
    const date = calendarDate();
    const { client, paths } = respondWith(
      200,
      JournalCalendar.entriesOnDateToJson({ date, entries: [written] }),
    );

    const result = await client.getEntriesOnDate(date, "Asia/Tokyo");

    expect(paths).toEqual(["/api/journal-entries/by-date?date=2026-10-17&timeZone=Asia%2FTokyo"]);
    expect(Result.isSuccess(result) && result.value.entries.map(JournalEntry.toJson)).toEqual([
      JournalEntry.toJson(written),
    ]);
  });
});

describe("タグのついた記入", () => {
  const page = TaggedEntries.page(readingTag, [written], 20);

  test("GET /api/journal-entries/by-tag にタグを渡し、1ページを返す", async () => {
    const { client, paths } = respondWith(200, TaggedEntries.toJson(page));

    const result = await client.getEntriesWithTag(readingTag);

    expect(paths).toEqual([`/api/journal-entries/by-tag?tag=${encodeURIComponent("読書")}`]);
    expect(Result.isSuccess(result) && result.value.next).toEqual({ kind: "End" });
  });

  test("続きは before に前のページのいちばん古い時刻を渡す", async () => {
    const { client, paths } = respondWith(200, TaggedEntries.toJson(page));

    await client.getEntriesWithTag(readingTag, at(5));

    expect(paths).toEqual([
      `/api/journal-entries/by-tag?tag=${encodeURIComponent("読書")}&before=${encodeURIComponent(at(5).toISOString())}`,
    ]);
  });

  test("ログインしていなければ、UNAUTHENTICATED の ApiRejected を返す", async () => {
    const { client } = respondWith(401, { error: "UNAUTHENTICATED" });

    expect(await client.getEntriesWithTag(readingTag)).toEqual(
      Result.fail({ kind: "ApiRejected", status: 401, code: "UNAUTHENTICATED" }),
    );
  });
});

describe("フェーズの進め方", () => {
  const mode = { ...AdvanceMode.default, FocusToJournal: "Manual" } as const;

  test("GET /api/settings/advance-mode を呼び、いまの進め方を返す", async () => {
    const { client, paths } = respondWith(200, mode);

    expect(await client.getAdvanceMode()).toEqual(Result.succeed(mode));
    expect(paths).toEqual(["/api/settings/advance-mode"]);
  });

  test("変えるときは4つの切り替わりの進め方を本文に入れて PUT する", async () => {
    const { client, paths, requests } = respondWith(200, mode);

    expect(await client.changeAdvanceMode(mode)).toEqual(Result.succeed(mode));
    expect(paths).toEqual(["/api/settings/advance-mode"]);
    expect(requests[0]).toMatchObject({ method: "PUT", body: JSON.stringify(mode) });
  });

  test("応答の進め方が自動・手動のどちらでもなければ UnexpectedResponse を返す", async () => {
    const { client } = respondWith(200, { ...mode, BreakToFocus: "Sometimes" });

    expect(await client.getAdvanceMode()).toEqual(
      Result.fail({ kind: "UnexpectedResponse", status: 200 }),
    );
  });
});
