import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import { ApiErrorBodyJsonSchema } from "../domain/api-error.ts";
import { schemaResult } from "../domain/schema-result.ts";
import { SessionSnapshotJsonSchema } from "../domain/session.ts";
import { prepareDatabase, request, resetStorage, signInAs } from "./workers-test-harness.ts";

// テストの時計は `vi.setSystemTime` で進めるが、alarm の発火はランタイムの本当の時計で決まる。
// 過去の時刻に張った alarm はすぐ鳴ってしまうので、本当の時計より先の時刻でテストする。
// alarm は `runDurableObjectAlarm` で鳴らす。
const STARTED_AT = Date.UTC(2100, 0, 1, 0, 0, 0);
/** セッションを始めた時刻からの経過（`minutes(7)` は開始から7分後） */
const minutes = (m: number, s = 0) => STARTED_AT + m * 60_000 + s * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const passTo = (ms: number) => vi.setSystemTime(ms);

let headers: Headers;
let userId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  passTo(minutes(0));
  await prepareDatabase();
  ({ headers, userId } = await signInAs("me@example.com"));
});

afterEach(async () => {
  vi.useRealTimers();
  await resetStorage();
});

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { cookie: headers.get("cookie") ?? "", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const getCurrent = () => request("/api/session/current", { headers });
const start = (id: string = crypto.randomUUID()) => request("/api/session", json({ id }));
const operate = (kind: string, id: string = crypto.randomUUID()) =>
  request("/api/session/commands", json({ id, kind }));

const userDO = () => env.USER_DO.getByName(userId);

describe("ログインしていないとき", () => {
  test.each([
    ["GET", "/api/session/current"],
    ["POST", "/api/session"],
    ["POST", "/api/session/commands"],
  ])("%s %s は 401 を返す", async (method, path) => {
    const res = await request(path, { method });

    expect(res.status).toBe(401);
  });
});

describe("現在のセッション", () => {
  test("セッションがなければ NoSession とサーバー時刻を返す", async () => {
    const res = await getCurrent();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "NoSession", serverTime: iso(minutes(0)) });
  });

  test("開始したセッションの操作イベントと、サーバー時刻での状態を返す", async () => {
    const startId = crypto.randomUUID();
    await start(startId);
    passTo(minutes(3, 20));

    const res = await getCurrent();

    expect(await res.json()).toMatchObject({
      kind: "Session",
      serverTime: iso(minutes(3, 20)),
      session: {
        events: [{ kind: "Start", id: startId, at: iso(minutes(0)) }],
        journalEntryTimes: [],
      },
      state: { kind: "Focus", round: 1, setNumber: 1, remainingSeconds: 3 * 60 + 40 },
    });
  });

  test("セッションはユーザーごとに別で、他のユーザーのセッションは見えない", async () => {
    await start();
    const other = await signInAs("someone@example.com");

    const res = await request("/api/session/current", { headers: other.headers });

    expect(await res.json()).toMatchObject({ kind: "NoSession" });
  });
});

describe("開始", () => {
  test("開始すると1ラウンド目の1セット目の集中がすぐに始まる", async () => {
    const res = await start();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: "Session",
      state: { kind: "Focus", round: 1, setNumber: 1, completedSets: 0, remainingSeconds: 7 * 60 },
    });
  });

  test("同時に持てるセッションは1つまでなので、セッション中に開始すると 409 を返す", async () => {
    await start();

    const res = await start();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "SESSION_ALREADY_IN_PROGRESS" });
  });

  test("同じ ID の開始を2回送っても、セッションは1つだけで2回目も成功として返す", async () => {
    const id = crypto.randomUUID();
    const first = await (await start(id)).json<{ session: { id: string } }>();
    passTo(minutes(1));

    const second = await start(id);

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      session: { id: first.session.id, events: [{ id }] },
    });
  });

  test("ID が UUID でなければ 400 を返し、どの項目が不正かだけを示す", async () => {
    const res = await start("not-a-uuid");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST", paths: ["id"] });
  });

  test("本文が JSON でなければ 400 を返す", async () => {
    const res = await request("/api/session", { ...json({}), body: "{" });

    expect(res.status).toBe(400);
  });
});

describe("操作", () => {
  test("一時停止すると残り時間が止まり、再開すると続きから進む", async () => {
    await start();
    passTo(minutes(2));
    await operate("Pause");
    passTo(minutes(10));

    const paused = await (await getCurrent()).json();
    expect(paused).toMatchObject({
      state: { kind: "Focus", remainingSeconds: 5 * 60, clock: { kind: "Paused" } },
    });

    const resumed = await operate("Resume");
    expect(await resumed.json()).toMatchObject({
      state: {
        kind: "Focus",
        remainingSeconds: 5 * 60,
        clock: { kind: "Running", endsAt: iso(minutes(15)) },
      },
    });
  });

  test("集中中に中断すると待機に戻り、集中の再開始で同じセット番号からやり直す", async () => {
    await start();
    passTo(minutes(10));

    const aborted = await operate("Abort");
    expect(await aborted.json()).toMatchObject({
      state: { kind: "Idle", round: 1, setNumber: 2, completedSets: 1 },
    });

    passTo(minutes(12));
    const restarted = await operate("RestartFocus");
    expect(await restarted.json()).toMatchObject({
      state: { kind: "Focus", round: 1, setNumber: 2, remainingSeconds: 7 * 60 },
    });
  });

  test("休憩中に休憩スキップすると、次のラウンドの1セット目の集中がすぐに始まる", async () => {
    await start();
    passTo(minutes(25));

    const res = await operate("SkipBreak");

    expect(await res.json()).toMatchObject({
      state: { kind: "Focus", round: 2, setNumber: 1, completedSets: 3 },
    });
  });

  test("その状態ではできない操作は 409 を返し、記録しない", async () => {
    await start();

    const res = await operate("SkipBreak");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "OPERATION_REJECTED",
      operation: "SkipBreak",
      during: "Focus",
    });
    expect(await (await getCurrent()).json()).toMatchObject({
      session: { events: [{ kind: "Start" }] },
    });
  });

  test("同じ ID の操作を2回送っても1回分しか記録しない", async () => {
    await start();
    const id = crypto.randomUUID();
    passTo(minutes(1));
    await operate("Pause", id);
    passTo(minutes(2));

    const retried = await operate("Pause", id);

    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      session: { events: [{ kind: "Start" }, { kind: "Pause", id, at: iso(minutes(1)) }] },
      state: { kind: "Focus", clock: { kind: "Paused", pausedAt: iso(minutes(1)) } },
    });
  });

  test("記録済みの操作と同じ ID で別の操作を送ると 409 を返す", async () => {
    await start();
    const id = crypto.randomUUID();
    await operate("Pause", id);

    const res = await operate("Resume", id);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "EVENT_ID_CONFLICT" });
  });

  test("知らない種類の操作は 400 を返す", async () => {
    await start();

    const res = await operate("Start");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST", paths: ["kind"] });
  });

  test("セッションの外で操作すると 409 を返す", async () => {
    const res = await operate("Pause");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "NO_SESSION_IN_PROGRESS" });
  });
});

describe("終了", () => {
  test("終了するとセッションが閉じ、現在のセッションがなくなる", async () => {
    await start();
    passTo(minutes(9));

    const ended = await operate("End");

    expect(await ended.json()).toMatchObject({
      state: { kind: "Ended", endedBy: "End", endedAt: iso(minutes(9)), completedSets: 1 },
    });
    expect(await (await getCurrent()).json()).toMatchObject({ kind: "NoSession" });
  });

  test("終了したあとは新しいセッションを開始できる", async () => {
    const firstId = crypto.randomUUID();
    await start(firstId);
    await operate("End");

    const res = await start();

    expect(res.status).toBe(200);
    expect(await res.json()).not.toMatchObject({ session: { events: [{ id: firstId }] } });
  });

  test("終了の再送には、閉じたセッションの終了の状態を返す", async () => {
    await start();
    const id = crypto.randomUUID();
    passTo(minutes(9));
    await operate("End", id);
    passTo(minutes(10));

    const retried = await operate("End", id);

    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      state: { kind: "Ended", endedBy: "End", endedAt: iso(minutes(9)) },
    });
  });

  test("終了すると自動終了の alarm を外す", async () => {
    await start();
    await operate("End");

    const alarm = await runInDurableObject(userDO(), (_, state) => state.storage.getAlarm());

    expect(alarm).toBeNull();
  });
});

describe("自動終了", () => {
  const ROUND_MINUTES = 3 * 8 + 5;

  const alarmOf = () => runInDurableObject(userDO(), (_, state) => state.storage.getAlarm());

  test("開始すると、2ラウンド分（58分）後に自動終了の alarm が張られる", async () => {
    await start();

    expect(await alarmOf()).toBe(minutes(2 * ROUND_MINUTES));
  });

  test("操作するたびに、最後の操作から2ラウンド分の位置に alarm を張り直す", async () => {
    await start();
    passTo(minutes(5));
    await operate("Pause");

    expect(await alarmOf()).toBe(minutes(5 + 2 * ROUND_MINUTES));
  });

  test("ジャーナル記入があれば、最後の記入から2ラウンド分の位置に alarm を張り直す", async () => {
    await start();
    const { session } = await (await getCurrent()).json<{ session: { id: string } }>();
    // 記入の API は #6 で作るので、テストでは行を直接入れる
    await runInDurableObject(userDO(), (_, state) => {
      state.storage.sql.exec(
        `INSERT INTO journal_entries (id, session_id, body, written_at, round, set_number, phase, updated_at)
         VALUES (?, ?, 'メモ', ?, 1, 1, 'Journal', ?)`,
        crypto.randomUUID(),
        session.id,
        minutes(7, 30),
        minutes(7, 30),
      );
    });
    passTo(minutes(8));

    await getCurrent();

    expect(await alarmOf()).toBe(minutes(7, 30) + 2 * ROUND_MINUTES * 60_000);
  });

  test("記入も操作もないまま58分過ぎると alarm で自動終了し、最後の操作の時刻で閉じる", async () => {
    await start();
    passTo(minutes(10));
    await operate("Pause");
    passTo(minutes(10 + 2 * ROUND_MINUTES));

    expect(await runDurableObjectAlarm(userDO())).toBe(true);

    expect(await (await getCurrent()).json()).toMatchObject({ kind: "NoSession" });
    const ended = await runInDurableObject(userDO(), (_, state) =>
      state.storage.sql.exec("SELECT ended_at, ended_by FROM sessions").toArray(),
    );
    expect(ended).toEqual([{ ended_at: minutes(10), ended_by: "AutoEnd" }]);
    expect(await alarmOf()).toBeNull();
  });

  test("alarm が遅れても、自動終了の時刻を過ぎていれば現在のセッションはない", async () => {
    await start();
    passTo(minutes(2 * ROUND_MINUTES));

    expect(await (await getCurrent()).json()).toMatchObject({ kind: "NoSession" });
  });

  test("自動終了したあとは、新しいセッションを開始できる", async () => {
    await start();
    passTo(minutes(2 * ROUND_MINUTES + 1));

    const res = await start();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: { kind: "Focus", round: 1, setNumber: 1 } });
  });

  test("自動終了したセッションに操作すると、セッションの外として 409 を返す", async () => {
    await start();
    passTo(minutes(2 * ROUND_MINUTES));

    const res = await operate("Pause");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "NO_SESSION_IN_PROGRESS" });
  });
});

describe("API だけでセッションを最初から最後まで回す", () => {
  test("開始 → 一時停止 → 再開 → 休憩スキップ → 中断 → 集中の再開始 → 終了", async () => {
    expect((await start()).status).toBe(200);

    passTo(minutes(3));
    expect((await operate("Pause")).status).toBe(200);
    passTo(minutes(4));
    expect((await operate("Resume")).status).toBe(200);

    // 1分止めていたので、休憩は 25分〜30分 の位置にある
    passTo(minutes(26));
    expect(await (await getCurrent()).json()).toMatchObject({ state: { kind: "Break", round: 1 } });
    expect((await operate("SkipBreak")).status).toBe(200);

    passTo(minutes(28));
    expect((await operate("Abort")).status).toBe(200);
    passTo(minutes(29));
    expect((await operate("RestartFocus")).status).toBe(200);

    passTo(minutes(40));
    const ended = await operate("End");

    expect(await ended.json()).toMatchObject({
      session: {
        events: [
          { kind: "Start" },
          { kind: "Pause" },
          { kind: "Resume" },
          { kind: "SkipBreak" },
          { kind: "Abort" },
          { kind: "RestartFocus" },
          { kind: "End" },
        ],
      },
      state: { kind: "Ended", endedBy: "End", completedSets: 4 },
    });
    expect(await (await getCurrent()).json()).toMatchObject({ kind: "NoSession" });
  });
});

describe("応答はクライアントが検証するスキーマ（domain/）に合う", () => {
  const parseSnapshot = schemaResult(SessionSnapshotJsonSchema);
  const parseErrorBody = schemaResult(ApiErrorBodyJsonSchema);

  test("セッションなしの現在のセッションは、スナップショットのスキーマに合う", async () => {
    const parsed = parseSnapshot(await (await getCurrent()).json());

    expect(parsed).toEqual(Result.succeed({ kind: "NoSession", serverTime: new Date(minutes(0)) }));
  });

  test("一時停止・中断・休憩・終了を経たスナップショットも、スキーマで元の時刻に戻せる", async () => {
    await start();
    passTo(minutes(2));
    await operate("Pause");
    passTo(minutes(3));
    expect(Result.isSuccess(parseSnapshot(await (await getCurrent()).json()))).toBe(true);

    await operate("Resume");
    passTo(minutes(5));
    expect(Result.isSuccess(parseSnapshot(await (await operate("Abort")).json()))).toBe(true);

    // 5分に1セット目からやり直したので、休憩は 29分〜34分 の位置にある
    await operate("RestartFocus");
    passTo(minutes(31));
    const inBreak = parseSnapshot(await (await getCurrent()).json());
    expect(Result.isSuccess(inBreak) && inBreak.value).toMatchObject({
      kind: "Session",
      serverTime: new Date(minutes(31)),
      state: { kind: "Break" },
    });

    const ended = parseSnapshot(await (await operate("End")).json());
    expect(Result.isSuccess(ended) && ended.value).toMatchObject({
      state: { kind: "Ended", endedAt: new Date(minutes(31)) },
    });
  });

  test.each([
    ["未ログイン", () => request("/api/session/current"), "UNAUTHENTICATED"],
    ["入力が不正", () => start("not-a-uuid"), "INVALID_REQUEST"],
    ["セッションの外での操作", () => operate("Pause"), "NO_SESSION_IN_PROGRESS"],
  ] as const)("%sのエラーの応答は、エラーの本文のスキーマに合う", async (_, send, code) => {
    const parsed = parseErrorBody(await (await send()).json());

    expect(Result.isSuccess(parsed) && parsed.value.error).toBe(code);
  });
});
