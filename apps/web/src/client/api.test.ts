import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { SessionEventId } from "../domain/session-event.ts";
import { JournalEntry, JournalEntryBody, JournalEntryId } from "../domain/journal-entry.ts";
import { Session, SessionId, type SessionSnapshot } from "../domain/session.ts";
import { Timeline } from "../domain/timeline.ts";
import { createApiClient } from "./api.ts";

const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
const at = (minutes: number) => new Date(STARTED_AT + minutes * 60_000);

const started = Session.start(
  v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000000"),
  v.parse(SessionEventId.schema, "00000000-0000-4000-8000-000000000001"),
  at(0),
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

const written = (() => {
  const result = JournalEntry.write({
    id: entryId,
    body: v.parse(JournalEntryBody.schema, "メモ"),
    sessionId: started.id,
    state: Session.stateAt(started, at(3)),
    now: at(3),
  });
  if (Result.isFailure(result)) throw new Error("書けなかった");
  return result.value;
})();

/** 本文は `Sensitive` なので、比べるときは取り出した形にする */
const unwrapped = (result: Result.Result<JournalEntry, unknown>) =>
  Result.isSuccess(result) ? JournalEntry.toJson(result.value) : result;

describe("ジャーナル記入", () => {
  test("記入の ID と本文を本文に入れて POST /api/journal-entries を呼び、書いた記入を返す", async () => {
    const { client, paths, requests } = respondWith(200, JournalEntry.toJson(written));

    const result = await client.writeJournalEntry(entryId, "メモ");

    expect(paths).toEqual(["/api/journal-entries"]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ id: entryId, body: "メモ" }),
    });
    expect(unwrapped(result)).toEqual(JournalEntry.toJson(written));
  });

  test("セッションの外で書くと、NO_SESSION_IN_PROGRESS の ApiRejected を返す", async () => {
    const { client } = respondWith(409, { error: "NO_SESSION_IN_PROGRESS" });

    expect(await client.writeJournalEntry(entryId, "メモ")).toEqual(
      Result.fail({ kind: "ApiRejected", status: 409, code: "NO_SESSION_IN_PROGRESS" }),
    );
  });

  test("編集は PATCH /api/journal-entries/:id を呼び、書き直した記入を返す", async () => {
    const edited = JournalEntry.edit(written, v.parse(JournalEntryBody.schema, "直した"), at(9));
    const { client, paths, requests } = respondWith(200, JournalEntry.toJson(edited));

    const result = await client.editJournalEntry(entryId, "直した");

    expect(paths).toEqual([`/api/journal-entries/${entryId}`]);
    expect(requests[0]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ body: "直した" }),
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
