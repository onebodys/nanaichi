import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { EntriesOnDateJsonSchema, JournalCalendarJsonSchema } from "../domain/journal-calendar.ts";
import { schemaResult } from "../domain/schema-result.ts";
import { TaggedEntriesPageJsonSchema } from "../domain/tagged-entries.ts";
import { prepareDatabase, request, resetStorage, signInAs } from "./workers-test-harness.ts";

// 時計の扱いは stats-api.workers.test.ts と同じ。alarm がすぐ鳴らないよう、本当の時計より先の時刻でテストする。
// 2100-01-01 0:00（UTC）は日本時間の 9:00
const STARTED_AT = Date.UTC(2100, 0, 1, 0, 0, 0);
const DAY_MS = 86_400_000;
/** 最初のセッションを始めた時刻からの経過 */
const minutes = (m: number, s = 0) => STARTED_AT + m * 60_000 + s * 1000;

const passTo = (ms: number) => vi.setSystemTime(ms);

let headers: Headers;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  passTo(minutes(0));
  await prepareDatabase();
  ({ headers } = await signInAs("me@example.com"));
});

afterEach(async () => {
  vi.useRealTimers();
  await resetStorage();
});

const withBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { cookie: headers.get("cookie") ?? "", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const start = () => request("/api/session", withBody("POST", { id: crypto.randomUUID() }));
const end = () =>
  request("/api/session/commands", withBody("POST", { id: crypto.randomUUID(), kind: "End" }));
const write = async (body: string, tags: ReadonlyArray<string> = []) =>
  (
    await request("/api/journal-entries", withBody("POST", { id: crypto.randomUUID(), body, tags }))
  ).json<{ id: string }>();
const remove = (id: string) => request(`/api/journal-entries/${id}`, { method: "DELETE", headers });

/** 時刻 `at` にセッションを始め、記入を1件書いて終える */
const writeInSessionAt = async (at: number, body: string, tags: ReadonlyArray<string> = []) => {
  passTo(at);
  await start();
  passTo(at + 60_000);
  const written = await write(body, tags);
  await end();
  return written;
};

const get = (path: string, query: Record<string, string>) =>
  request(`${path}?${new URLSearchParams(query).toString()}`, { headers });

/** 応答をスキーマで検証してから使う（画面と同じ） */
const parsed = async <T>(res: Response, schema: StandardSchemaV1<unknown, T>): Promise<T> => {
  expect(res.status).toBe(200);
  const result = schemaResult(schema)(await res.json());
  if (Result.isFailure(result)) {
    throw new Error("応答がスキーマに合わない");
  }
  return result.value;
};

const calendarOf = async (month: string, timeZone = "Asia/Tokyo") =>
  parsed(await get("/api/journal-calendar", { month, timeZone }), JournalCalendarJsonSchema);

const entriesOn = async (date: string, timeZone = "Asia/Tokyo") =>
  parsed(await get("/api/journal-entries/by-date", { date, timeZone }), EntriesOnDateJsonSchema);

const entriesWithTag = async (tag: string, before?: string) =>
  parsed(
    await get("/api/journal-entries/by-tag", before === undefined ? { tag } : { tag, before }),
    TaggedEntriesPageJsonSchema,
  );

describe("ログインしていないとき", () => {
  test.each([
    "/api/journal-calendar?month=2100-01&timeZone=Asia%2FTokyo",
    "/api/journal-entries/by-date?date=2100-01-01&timeZone=Asia%2FTokyo",
    "/api/journal-entries/by-tag?tag=reading",
  ])("GET %s は 401 を返す", async (path) => {
    expect((await request(path)).status).toBe(401);
  });
});

describe("ジャーナルのカレンダー", () => {
  test("その月の日ごとに、削除していない記入の数を数える", async () => {
    await writeInSessionAt(minutes(0), "1日目のメモ");
    passTo(minutes(2));
    await start();
    await write("同じ日の2件目");
    const removed = await write("消すメモ");
    await remove(removed.id);
    await end();
    await writeInSessionAt(STARTED_AT + 2 * DAY_MS, "3日目のメモ");

    const calendar = await calendarOf("2100-01");

    expect(calendar.month).toEqual({ year: 2100, month: 1 });
    expect(calendar.today.key).toBe("2100-01-03");
    expect(calendar.days.slice(0, 4)).toEqual([
      { kind: "Day", date: expect.objectContaining({ key: "2100-01-01" }), entries: 2 },
      { kind: "Day", date: expect.objectContaining({ key: "2100-01-02" }), entries: 0 },
      { kind: "Day", date: expect.objectContaining({ key: "2100-01-03" }), entries: 1 },
      { kind: "Upcoming", date: expect.objectContaining({ key: "2100-01-04" }) },
    ]);
  });

  test("日付は端末のタイムゾーンで区切る", async () => {
    // 日本時間 2100-01-01 9:01 は、ロサンゼルスでは 2099-12-31 16:01
    await writeInSessionAt(minutes(0), "年越しのメモ");

    const inLosAngeles = await calendarOf("2099-12", "America/Los_Angeles");

    expect(inLosAngeles.days.at(-1)).toMatchObject({ kind: "Day", entries: 1 });
    expect((await calendarOf("2100-01", "America/Los_Angeles")).days[0]).toMatchObject({
      kind: "Upcoming",
    });
  });

  test.each([
    ["月がない", "/api/journal-calendar?timeZone=Asia%2FTokyo"],
    ["月が不正", "/api/journal-calendar?month=2100-13&timeZone=Asia%2FTokyo"],
    ["タイムゾーンが不正", "/api/journal-calendar?month=2100-01&timeZone=Mars%2FOlympus"],
  ])("%s と 400 を返す", async (_, path) => {
    const res = await request(path, { headers });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVALID_REQUEST" });
  });
});

describe("選んだ日の記入", () => {
  test("その日に書いた削除していない記入を、書いた順に返す", async () => {
    passTo(minutes(0));
    await start();
    passTo(minutes(1));
    await write("朝のメモ", ["読書"]);
    passTo(minutes(2));
    const removed = await write("消すメモ");
    await remove(removed.id);
    passTo(minutes(3));
    await write("昼のメモ");
    await end();
    await writeInSessionAt(STARTED_AT + DAY_MS, "次の日のメモ");

    const found = await entriesOn("2100-01-01");

    expect(found.date.key).toBe("2100-01-01");
    expect(found.entries.map((entry) => entry.body.unwrap())).toEqual(["朝のメモ", "昼のメモ"]);
    expect(found.entries[0]?.tags).toEqual(["読書"]);
  });

  test("記入のない日は空の一覧を返す", async () => {
    expect((await entriesOn("2099-06-15")).entries).toEqual([]);
  });

  test.each([
    ["日付がない", "/api/journal-entries/by-date?timeZone=Asia%2FTokyo"],
    ["暦にない日付", "/api/journal-entries/by-date?date=2100-02-30&timeZone=Asia%2FTokyo"],
    ["タイムゾーンがない", "/api/journal-entries/by-date?date=2100-01-01"],
  ])("%s と 400 を返す", async (_, path) => {
    const res = await request(path, { headers });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVALID_REQUEST" });
  });
});

describe("タグのついた記入", () => {
  test("そのタグのついた削除していない記入を新しい順に返す。名前の大文字・小文字は区別しない", async () => {
    passTo(minutes(0));
    await start();
    passTo(minutes(1));
    await write("古いメモ", ["reading"]);
    passTo(minutes(2));
    await write("ほかのタグ", ["writing"]);
    passTo(minutes(3));
    const removed = await write("消すメモ", ["reading"]);
    await remove(removed.id);
    passTo(minutes(4));
    await write("新しいメモ", ["Reading", "writing"]);
    await end();

    const page = await entriesWithTag("READING");

    expect(page.tag).toBe("reading");
    expect(page.entries.map((entry) => entry.body.unwrap())).toEqual(["新しいメモ", "古いメモ"]);
    expect(page.next).toEqual({ kind: "End" });
  });

  test("20件より多ければ、続きを before で読める", async () => {
    passTo(minutes(0));
    await start();
    for (let i = 1; i <= 21; i += 1) {
      passTo(minutes(0, i));
      await write(`${i}件目`, ["読書"]);
    }
    await end();

    const first = await entriesWithTag("読書");
    expect(first.entries).toHaveLength(20);
    expect(first.entries[0]?.body.unwrap()).toBe("21件目");
    if (first.next.kind !== "More") {
      throw new Error("続きがない");
    }

    const second = await entriesWithTag("読書", first.next.before.toISOString());
    expect(second.entries.map((entry) => entry.body.unwrap())).toEqual(["1件目"]);
    expect(second.next).toEqual({ kind: "End" });
  });

  test.each([
    ["タグがない", "/api/journal-entries/by-tag"],
    ["タグに空白がある", "/api/journal-entries/by-tag?tag=a%20b"],
    ["before が時刻でない", "/api/journal-entries/by-tag?tag=reading&before=yesterday"],
  ])("%s と 400 を返す", async (_, path) => {
    const res = await request(path, { headers });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVALID_REQUEST" });
  });
});
