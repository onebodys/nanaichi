import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import type { BackendError } from "../domain/backend.ts";
import type { ImportBatch, ImportReceipt, SessionImportOutcome } from "../domain/import.ts";
import { SessionEventId } from "../domain/session-event.ts";
import type { ClosedSession } from "../domain/session-record.ts";
import { SessionId } from "../domain/session.ts";
import type { DeviceImport, ImportableRecords } from "../device/index.ts";
import { runImport, type ImportProgress } from "./import-driver.ts";
import type { ImportCallError } from "./remote-backend.ts";

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const MINUTE = 60_000;

const closedSessions = (count: number): ReadonlyArray<ClosedSession> =>
  Array.from({ length: count }, (_, i) => ({
    id: v.parse(SessionId.schema, crypto.randomUUID()),
    events: [
      {
        kind: "Start",
        id: v.parse(SessionEventId.schema, crypto.randomUUID()),
        at: new Date(T0 + i * 30 * MINUTE),
      },
    ],
    entries: [],
    endedAt: new Date(T0 + (i * 30 + 10) * MINUTE),
    endedBy: "AutoEnd",
  }));

/** この端末の記録。消すたびに読み直す値が変わる */
const deviceWith = (
  sessions: ReadonlyArray<ClosedSession>,
  open: ImportableRecords["open"] = { kind: "NoOpenSession" },
) => {
  const state = {
    kept: [...sessions],
    removeFails: false,
  };
  const device: DeviceImport = {
    load: async () => Result.succeed({ sessions: [...state.kept], advanceModeChanges: [], open }),
    removeClosedSessions: async (ids) => {
      if (state.removeFails) {
        return Result.fail({ kind: "StorageFailed", reason: "QuotaExceeded" });
      }
      state.kept = state.kept.filter(({ id }) => !ids.includes(id));
      return Result.succeed(undefined);
    },
  };
  return { device, state };
};

type Reply = Readonly<{ kind: "Answer" }> | ImportCallError;

/**
 * サーバーの代わり。アカウントにあるセッションは AlreadyImported、`overlapping` は Overlapping。
 * `replies` があれば、先頭から順にその応答を返す（なくなったら答える）
 */
const serverWith = (
  options: Readonly<{
    overlapping?: ReadonlySet<SessionId>;
    replies?: ReadonlyArray<Reply>;
  }> = {},
) => {
  const account = new Set<SessionId>();
  const replies = [...(options.replies ?? [])];
  const answered: Array<SessionId> = [];
  const sent: Array<ReadonlyArray<SessionId>> = [];
  const send = async (
    batch: ImportBatch,
  ): Promise<Result.Result<ImportReceipt, ImportCallError>> => {
    sent.push(batch.sessions.map(({ id }) => id));
    const reply = replies.shift() ?? { kind: "Answer" };
    switch (reply.kind) {
      case "Answer":
        break;
      case "RateLimited":
      case "Unreachable":
      case "Rejected":
      case "StorageFailed":
      case "Broken":
        return Result.fail(reply);
    }
    const outcomes = batch.sessions.map(({ id }): SessionImportOutcome => {
      answered.push(id);
      if (options.overlapping?.has(id) === true) {
        return { sessionId: id, kind: "Overlapping" };
      }
      if (account.has(id)) {
        return { sessionId: id, kind: "AlreadyImported" };
      }
      account.add(id);
      return { sessionId: id, kind: "Imported" };
    });
    return Result.succeed({ outcomes });
  };
  return { send, account, answered, sent };
};

const run = (
  device: DeviceImport,
  send: (batch: ImportBatch) => Promise<Result.Result<ImportReceipt, ImportCallError>>,
) => {
  const waited: Array<number> = [];
  const progress: Array<ImportProgress> = [];
  const result = runImport({
    device,
    send,
    wait: async (ms) => {
      waited.push(ms);
    },
    onProgress: (p) => progress.push(p),
  });
  return { result, waited, progress };
};

const unreachable: BackendError = { kind: "Unreachable" };

describe("この端末の記録の取り込み", () => {
  test("束ごとに、アカウントに入ったセッションだけをこの端末から消し、進み具合を知らせる", async () => {
    const sessions = closedSessions(150);
    const { device, state } = deviceWith(sessions);
    const server = serverWith();

    const { result, progress } = run(device, server.send);

    expect(await result).toEqual(
      Result.succeed({ imported: 150, overlapping: 0, open: { kind: "NoOpenSession" } }),
    );
    expect(server.sent.map((ids) => ids.length)).toEqual([100, 50]);
    expect(progress).toEqual([
      { done: 0, total: 150 },
      { done: 100, total: 150 },
      { done: 150, total: 150 },
    ]);
    expect(state.kept).toEqual([]);
  });

  test("時間が重なったセッションはこの端末に残し、その数を返す", async () => {
    const sessions = closedSessions(3);
    const [, overlapped] = sessions;
    const { device, state } = deviceWith(sessions);
    const server = serverWith({ overlapping: new Set(overlapped && [overlapped.id]) });

    expect(await run(device, server.send).result).toEqual(
      Result.succeed({ imported: 2, overlapping: 1, open: { kind: "NoOpenSession" } }),
    );
    expect(state.kept).toEqual([overlapped]);
  });

  test("開いたままのセッションがこの端末にあれば、結果で知らせる", async () => {
    const { device } = deviceWith(closedSessions(1), { kind: "OpenSessionLeft" });

    expect(await run(device, serverWith().send).result).toEqual(
      Result.succeed({ imported: 1, overlapping: 0, open: { kind: "OpenSessionLeft" } }),
    );
  });

  test("429 なら Retry-After だけ待って同じ束を送り直し、答えをもらったセッションは送り直さない", async () => {
    const sessions = closedSessions(150);
    const [, overlapped] = sessions;
    const { device } = deviceWith(sessions);
    const server = serverWith({
      overlapping: new Set(overlapped && [overlapped.id]),
      replies: [{ kind: "Answer" }, { kind: "RateLimited", retryAfterMs: 7000 }],
    });

    const { result, waited } = run(device, server.send);

    expect(Result.isSuccess(await result)).toBe(true);
    expect(waited).toEqual([7000]);
    expect(server.sent.map((ids) => ids.length)).toEqual([100, 50, 50]);
    expect(new Set(server.answered).size).toBe(server.answered.length);
    expect(server.answered).toHaveLength(150);
  });

  test("429 が続いたら諦め、この端末からは何も消さない", async () => {
    const sessions = closedSessions(2);
    const { device, state } = deviceWith(sessions);
    const rateLimited = { kind: "RateLimited", retryAfterMs: 10_000 } as const;
    const server = serverWith({ replies: Array.from({ length: 6 }, () => rateLimited) });

    const { result, waited } = run(device, server.send);

    expect(await result).toEqual(Result.fail({ kind: "RateLimitedTooLong" }));
    expect(waited).toHaveLength(5);
    expect(state.kept).toEqual(sessions);
  });

  test("通信が切れたら止まり、やり直すと残りだけを送る", async () => {
    const sessions = closedSessions(150);
    const { device, state } = deviceWith(sessions);
    const server = serverWith({ replies: [{ kind: "Answer" }, unreachable] });

    expect(await run(device, server.send).result).toEqual(Result.fail(unreachable));
    expect(state.kept).toEqual(sessions.slice(100));

    server.sent.length = 0;
    expect(await run(device, server.send).result).toEqual(
      Result.succeed({ imported: 50, overlapping: 0, open: { kind: "NoOpenSession" } }),
    );
    expect(server.sent).toEqual([sessions.slice(100).map(({ id }) => id)]);
    expect(state.kept).toEqual([]);
  });

  test("この端末から消せなかったら止まり、やり直すとアカウントにすでにあるので消える", async () => {
    const sessions = closedSessions(2);
    const { device, state } = deviceWith(sessions);
    const server = serverWith();
    state.removeFails = true;

    expect(await run(device, server.send).result).toEqual(
      Result.fail({ kind: "StorageFailed", reason: "QuotaExceeded" }),
    );
    expect(server.account.size).toBe(2);
    expect(state.kept).toEqual(sessions);

    state.removeFails = false;
    expect(await run(device, server.send).result).toEqual(
      Result.succeed({ imported: 2, overlapping: 0, open: { kind: "NoOpenSession" } }),
    );
    expect(state.kept).toEqual([]);
  });
});
