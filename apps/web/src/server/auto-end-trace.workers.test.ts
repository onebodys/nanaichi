import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { prepareDatabase, request, resetStorage, signInAs } from "./workers-test-harness.ts";

/**
 * UserDO の自動終了の振る舞いをトレースとして書き出す（Issue #35）。
 *
 * 1歩ごとに、要求か alarm を1つ実行し、そのあとの閉じていないセッション・alarm・自動終了した数を記録する。
 * トレースは `specs/auto-end-alarm/traces/` に JSON で残し、`specs/auto-end-alarm/check.mjs` が
 * TLA+ のモデル（AutoEndAlarm.tla）に通して、モデルがこの並びを許すかを確かめる。
 * 実装の振る舞いが変わると JSON と食い違って落ちる（`vp test -u` で書き出し直し、モデルにも通す）。
 */

// alarm の発火はランタイムの本当の時計で決まるので、本当の時計より先の時刻でテストする（session-api.workers.test.ts）
const STARTED_AT = Date.UTC(2100, 0, 1, 0, 0, 0);
const AUTO_END_MINUTES = 2 * (3 * 8 + 5);
const minutes = (m: number) => m * 60_000;

const TRACE_DIR = decodeURIComponent(
  new URL("../../../../specs/auto-end-alarm/traces/", import.meta.url).pathname,
);

/** モデルの要求の種類（AutoEndAlarm.tla の Ops） */
type Op = "Start" | "Activity" | "End" | "Read";

type Observed = Readonly<{
  /** 閉じていないセッションがあるか */
  open: boolean;
  /** alarm の時刻（開始からのミリ秒）。張られていなければ null */
  alarm: number | null;
  /** 自動終了で閉じたセッションの数 */
  autoEnded: number;
}>;

type TraceStep =
  | Readonly<{ kind: "Request"; op: Op; now: number; after: Observed }>
  | Readonly<{ kind: "Alarm"; now: number; after: Observed }>;

let headers: Headers;
let userId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(STARTED_AT);
  await prepareDatabase();
  ({ headers, userId } = await signInAs("me@example.com"));
});

afterEach(async () => {
  vi.useRealTimers();
  await resetStorage();
});

const userDO = () => env.USER_DO.getByName(userId);

const post = (path: string, body: unknown): Promise<Response> =>
  request(path, {
    method: "POST",
    headers: { cookie: headers.get("cookie") ?? "", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** 送る要求と、それがモデルのどの要求か。どれも UserDO の #run を1回通る */
const requests = {
  start: { op: "Start", send: () => post("/api/session", { id: crypto.randomUUID() }) },
  pause: {
    op: "Activity",
    send: () => post("/api/session/commands", { id: crypto.randomUUID(), kind: "Pause" }),
  },
  journal: {
    op: "Activity",
    send: () => post("/api/journal-entries", { id: crypto.randomUUID(), body: "メモ" }),
  },
  end: {
    op: "End",
    send: () => post("/api/session/commands", { id: crypto.randomUUID(), kind: "End" }),
  },
  read: { op: "Read", send: () => request("/api/session/current", { headers }) },
} as const satisfies Record<string, Readonly<{ op: Op; send: () => Promise<Response> }>>;

const observe = (): Promise<Observed> =>
  runInDurableObject(userDO(), (_, state) => {
    const alarm = state.storage.getAlarm();
    const count = (where: string): number =>
      state.storage.sql
        .exec<{ n: number }>(`SELECT count(*) AS n FROM sessions WHERE ${where}`)
        .one().n;
    return alarm.then((at) => ({
      open: count("ended_at IS NULL") > 0,
      alarm: at === null ? null : at - STARTED_AT,
      autoEnded: count("ended_by = 'AutoEnd'"),
    }));
  });

/** トレースを1歩ずつ記録する。時刻は開始からの分で渡す */
const recorder = () => {
  const steps: TraceStep[] = [];
  return {
    steps,
    request: async (atMinutes: number, name: keyof typeof requests) => {
      vi.setSystemTime(STARTED_AT + minutes(atMinutes));
      const { op, send } = requests[name];
      await send();
      steps.push({ kind: "Request", op, now: minutes(atMinutes), after: await observe() });
    },
    alarm: async (atMinutes: number) => {
      vi.setSystemTime(STARTED_AT + minutes(atMinutes));
      expect(await runDurableObjectAlarm(userDO())).toBe(true);
      steps.push({ kind: "Alarm", now: minutes(atMinutes), after: await observe() });
    },
  };
};

const writeTrace = async (name: string, steps: ReadonlyArray<TraceStep>): Promise<void> => {
  const json = `${JSON.stringify({ name, steps }, null, 2)}\n`;
  await expect(json).toMatchFileSnapshot(`${TRACE_DIR}${name}.json`);
};

describe("自動終了のトレース", () => {
  test("開始して放っておくと、自動終了の時刻の alarm で自動終了として閉じる", async () => {
    const trace = recorder();
    await trace.request(0, "start");
    await trace.alarm(AUTO_END_MINUTES);

    expect(trace.steps.at(-1)?.after).toEqual({ open: false, alarm: null, autoEnded: 1 });
    await writeTrace("start-then-alarm", trace.steps);
  });

  test("操作と記入のたびに alarm を張り直し、最後の記入から2ラウンド分で閉じる", async () => {
    const trace = recorder();
    await trace.request(0, "start");
    await trace.request(10, "pause");
    await trace.request(20, "journal");
    await trace.request(30, "read");
    await trace.alarm(20 + AUTO_END_MINUTES);

    expect(trace.steps.map((step) => step.after.alarm)).toEqual([
      minutes(AUTO_END_MINUTES),
      minutes(10 + AUTO_END_MINUTES),
      minutes(20 + AUTO_END_MINUTES),
      minutes(20 + AUTO_END_MINUTES),
      null,
    ]);
    await writeTrace("activity-rearms", trace.steps);
  });

  test("alarm が鳴る前でも、自動終了の時刻を過ぎて読んだ要求が閉じ、alarm を消す", async () => {
    const trace = recorder();
    await trace.request(0, "start");
    await trace.request(AUTO_END_MINUTES - 1, "read");
    await trace.request(AUTO_END_MINUTES, "read");
    await trace.request(AUTO_END_MINUTES + 1, "pause");

    expect(trace.steps.map((step) => step.after.open)).toEqual([true, true, false, false]);
    await writeTrace("read-closes-late", trace.steps);
  });

  test("終了の操作で閉じると alarm を消し、セッション中の開始は断られて alarm は変わらない", async () => {
    const trace = recorder();
    await trace.request(0, "start");
    await trace.request(3, "start");
    await trace.request(5, "end");
    await trace.request(6, "start");
    await trace.alarm(6 + AUTO_END_MINUTES);

    expect(trace.steps.map((step) => step.after.autoEnded)).toEqual([0, 0, 0, 0, 1]);
    await writeTrace("end-and-restart", trace.steps);
  });
});
