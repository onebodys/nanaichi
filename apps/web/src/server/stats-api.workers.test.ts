import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import { schemaResult } from "../domain/schema-result.ts";
import { StatsReportJsonSchema, type StatsReport } from "../domain/stats.ts";
import { prepareDatabase, request, resetStorage, signInAs } from "./workers-test-harness.ts";

// 時計の扱いは journal-api.workers.test.ts と同じ。alarm がすぐ鳴らないよう、本当の時計より先の時刻でテストする。
// 2100-01-01 0:00（UTC）は日本時間の 9:00
const STARTED_AT = Date.UTC(2100, 0, 1, 0, 0, 0);
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
const operate = (kind: string) =>
  request("/api/session/commands", withBody("POST", { id: crypto.randomUUID(), kind }));
const write = (body: string, tags: ReadonlyArray<string> = []) =>
  request("/api/journal-entries", withBody("POST", { id: crypto.randomUUID(), body, tags }));
const remove = (id: string) => request(`/api/journal-entries/${id}`, { method: "DELETE", headers });

const stats = (period: string, timeZone = "Asia/Tokyo") =>
  request(`/api/stats?${new URLSearchParams({ period, timeZone }).toString()}`, { headers });

/** 応答をスキーマで検証してから使う（画面と同じ） */
const statsReport = async (period: string, timeZone?: string): Promise<StatsReport> => {
  const res = await stats(period, timeZone);
  expect(res.status).toBe(200);
  const parsed = schemaResult(StatsReportJsonSchema)(await res.json());
  if (Result.isFailure(parsed)) {
    throw new Error("応答がスキーマに合わない");
  }
  return parsed.value;
};

const activeOf = (report: StatsReport) => {
  if (report.activity.kind !== "Active") {
    throw new Error("期間の中に記録がない");
  }
  return report.activity;
};

describe("ログインしていないとき", () => {
  test("GET /api/stats は 401 を返す", async () => {
    const res = await request("/api/stats?period=Today&timeZone=Asia%2FTokyo");

    expect(res.status).toBe(401);
  });
});

describe("スタッツを読む", () => {
  test("記録がなければ、今日は記録なしで、連続日数は0日", async () => {
    const report = await statsReport("Today");

    expect(report.activity).toEqual({ kind: "NoActivity" });
    expect(report.streak).toEqual({ current: 0, longest: 0 });
    expect(report.today.key).toBe("2100-01-01");
  });

  test("完了セット・不成立セット・記入・タグを、端末のタイムゾーンの今日で数える", async () => {
    await start();
    passTo(minutes(7, 30));
    await write("1セット目の振り返り", ["読書"]);
    passTo(minutes(10));
    await operate("Abort");
    await operate("RestartFocus");
    passTo(minutes(17, 30));
    await write("2セット目の振り返り", ["読書"]);
    await operate("End");

    expect(activeOf(await statsReport("Today"))).toMatchObject({
      completedSets: 2,
      abortedSets: 1,
      entries: 2,
      completedSetsWithEntry: 2,
      tags: [{ name: "読書", completedSets: 2 }],
      comparison: { kind: "Compared", previousCompletedSets: 0 },
    });
  });

  test("削除した記入は、記入の数にも記入率にもタグにも数えない", async () => {
    await start();
    passTo(minutes(7, 30));
    const written = await (await write("消すメモ", ["読書"])).json<{ id: string }>();
    await remove(written.id);
    await operate("End");

    expect(activeOf(await statsReport("Today"))).toMatchObject({
      completedSets: 1,
      entries: 0,
      completedSetsWithEntry: 0,
      tags: [],
    });
  });

  test("1日に10件より多くセッションがあっても、今日の完了セットをすべて数える", async () => {
    for (let i = 0; i < 12; i += 1) {
      passTo(minutes(i * 10));
      await start();
      passTo(minutes(i * 10 + 8));
      await operate("End");
    }

    expect(activeOf(await statsReport("Today")).completedSets).toBe(12);
  });

  test("進行中のセッションも、今の時刻までに完了したセットを数える", async () => {
    await start();
    passTo(minutes(16));

    expect(activeOf(await statsReport("Today")).completedSets).toBe(2);
  });

  test("タイムゾーンが変われば、日付の区切りも変わる", async () => {
    // 日本時間 9:00 は、ロサンゼルスでは前の日の 16:00（2099-12-31）
    await start();
    passTo(minutes(8));
    await operate("End");

    expect((await statsReport("Today", "America/Los_Angeles")).today.key).toBe("2099-12-31");
    expect(activeOf(await statsReport("Week", "America/Los_Angeles")).completedSets).toBe(1);
  });

  test.each([
    ["期間がない", "/api/stats?timeZone=Asia%2FTokyo"],
    ["期間が不正", "/api/stats?period=Year&timeZone=Asia%2FTokyo"],
    ["タイムゾーンがない", "/api/stats?period=Today"],
    ["タイムゾーンが不正", "/api/stats?period=Today&timeZone=Mars%2FOlympus"],
  ])("%s と 400 を返す", async (_, path) => {
    const res = await request(path, { headers });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "INVALID_REQUEST" });
  });
});
