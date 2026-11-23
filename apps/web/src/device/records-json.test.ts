import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { JournalEntryId, type JournalEntry } from "../domain/journal-entry.ts";
import { Sensitive } from "../domain/sensitive.ts";
import type { ClosedSession, StoredEntry } from "../domain/session-record.ts";
import { SessionEventId } from "../domain/session-event.ts";
import { SessionId } from "../domain/session.ts";
import { TagName } from "../domain/tag.ts";
import { deleteJournalEntry } from "../workflows/delete-journal-entry.ts";
import { getCurrentSession } from "../workflows/get-current-session.ts";
import { startSession } from "../workflows/start-session.ts";
import { writeJournalEntry } from "../workflows/write-journal-entry.ts";
import {
  changedSessionRecords,
  DeviceRecords,
  recordsDeps,
  sessionRecordsOf,
  type Draft,
} from "./records.ts";
import { decodeRecords, encodeMetaRecord, encodeSessionRecord } from "./records-json.ts";

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const newSessionId = () => v.parse(SessionId.schema, crypto.randomUUID());
const entryId = () => v.parse(JournalEntryId.schema, crypto.randomUUID());

const encode = (records: DeviceRecords) => ({
  meta: encodeMetaRecord(records),
  sessions: sessionRecordsOf(records).map(encodeSessionRecord),
});

const reload = (records: DeviceRecords): DeviceRecords => {
  const { meta, sessions } = encode(records);
  const decoded = decodeRecords(meta, sessions);
  if (Result.isFailure(decoded)) {
    throw new Error(`読み込めなかった: ${JSON.stringify(decoded.error)}`);
  }
  return decoded.value;
};

const fresh = (): Draft => ({
  base: DeviceRecords.empty,
  current: DeviceRecords.empty,
  revision: 0,
});

describe("保存の形", () => {
  test("記入の本文は伏せ字にならずに保存され、読み込み直すと同じ記録に戻る", () => {
    const draft = fresh();
    const deps = recordsDeps(draft);
    startSession(deps)({ id: crypto.randomUUID() }, at(0), newSessionId());
    const id = entryId();
    writeJournalEntry(deps)({ id, body: "今日は読書をした", tags: ["読書"] }, at(1));

    const { sessions } = encode(draft.current);
    expect(sessions.join("")).not.toContain("[REDACTED]");
    expect(sessions.join("")).toContain("今日は読書をした");

    const reloaded = reload(draft.current);
    const found = recordsDeps({ base: reloaded, current: reloaded, revision: 0 }).findJournalEntry(
      id,
    );
    expect(found?.kind === "Written" && found.entry.body.unwrap()).toBe("今日は読書をした");
    expect(encode(reloaded)).toEqual(encode(draft.current));
  });

  test("読み込み直した削除済みの記入も、自動終了の時刻を延ばす", () => {
    const draft = fresh();
    const deps = recordsDeps(draft);
    const startId = crypto.randomUUID();
    startSession(deps)({ id: startId }, at(0), newSessionId());
    const id = entryId();
    writeJournalEntry(deps)({ id, body: "書いて消す" }, at(30));
    deleteJournalEntry(deps)(id, at(31));

    const reloaded = { base: reload(draft.current), current: reload(draft.current), revision: 0 };
    const reloadedDeps = recordsDeps(reloaded);
    expect(JSON.stringify(encode(reloaded.current))).not.toContain("書いて消す");
    expect(getCurrentSession(reloadedDeps)(at(87)).kind).toBe("Session");
    expect(getCurrentSession(reloadedDeps)(at(89)).kind).toBe("NoSession");
    expect(startSession(reloadedDeps)({ id: startId }, at(90), newSessionId())).toMatchObject({
      type: "Success",
      value: { state: { kind: "Ended", endedBy: "AutoEnd", endedAt: at(30) } },
    });
  });

  test("新しい版のアプリが書いた記録は、新しい版として読まない", () => {
    const { sessions } = encode(DeviceRecords.empty);

    expect(decodeRecords(JSON.stringify({ version: 2, futureField: [] }), sessions)).toEqual(
      Result.fail({ kind: "NewerFormat", version: 2 }),
    );
  });

  test("壊れた記録は例外にせず読めないとして返し、本文を出さない", () => {
    const draft = fresh();
    const deps = recordsDeps(draft);
    startSession(deps)({ id: crypto.randomUUID() }, at(0), newSessionId());
    writeJournalEntry(deps)({ id: entryId(), body: "秘密の本文" }, at(1));
    const { meta, sessions } = encode(draft.current);
    const [session = ""] = sessions;

    expect(decodeRecords("{", sessions)).toEqual(
      Result.fail({ kind: "Malformed", paths: ["(json)"] }),
    );
    const broken = decodeRecords(meta, [session.replace('"Written"', '"Scribbled"')]);
    expect(broken).toMatchObject({ type: "Failure", error: { kind: "Malformed" } });
    expect(JSON.stringify(broken)).not.toContain("秘密の本文");
    expect(decodeRecords(meta, [session, session])).toEqual(
      Result.fail({ kind: "Malformed", paths: ["(open sessions)"] }),
    );
  });
});

const DAYS = 3 * 365;
const SESSIONS_PER_DAY = 8;
const TAGS = Array.from({ length: 12 }, (_, i) => v.parse(TagName.schema, `tag${i}`));
const BODY = "やったこと、次にやること、感想を書く。".repeat(10);

const syntheticRecords = (): DeviceRecords => {
  const closed = Array.from({ length: DAYS * SESSIONS_PER_DAY }, (_, i): ClosedSession => {
    const startedAt = T0 - (DAYS * SESSIONS_PER_DAY - i) * 3 * 3_600_000;
    const sessionId = v.parse(SessionId.schema, crypto.randomUUID());
    const entries = Array.from({ length: 6 + (i % 2) }, (_, j): StoredEntry => {
      const writtenAt = new Date(startedAt + (j + 1) * 60_000);
      const entry: JournalEntry = {
        id: v.parse(JournalEntryId.schema, crypto.randomUUID()),
        sessionId,
        body: Sensitive.of(BODY),
        tags: TAGS.slice((i + j) % TAGS.length, ((i + j) % TAGS.length) + 1),
        writtenAt,
        updatedAt: writtenAt,
        writtenDuring: { kind: "Focus", round: 1, setNumber: 1 },
      };
      return { kind: "Written", entry };
    });
    return {
      id: sessionId,
      events: [
        {
          kind: "Start",
          id: v.parse(SessionEventId.schema, crypto.randomUUID()),
          at: new Date(startedAt),
        },
        {
          kind: "End",
          id: v.parse(SessionEventId.schema, crypto.randomUUID()),
          at: new Date(startedAt + 30 * 60_000),
        },
      ],
      entries,
      endedAt: new Date(startedAt + 30 * 60_000),
      endedBy: "End",
    };
  });
  return { ...DeviceRecords.empty, closed };
};

describe("3年分の記録", () => {
  // 保存し直す件数が書いたセッションと進め方の2件で済むことを、数と同一性で確かめる。
  // 経過時間はマシンの負荷で変わるので比べない（#90）。
  test("記入を1件書いたときに保存し直すのは、書いたセッションと進め方の1件だけで済む", () => {
    const records = syntheticRecords();
    const draft: Draft = { base: records, current: records, revision: 0 };
    const deps = recordsDeps(draft);
    const sessionId = newSessionId();
    const started = startSession(deps)({ id: crypto.randomUUID() }, at(0), sessionId);
    expect(Result.isSuccess(started)).toBe(true);
    const loaded = draft.current;
    const commit: Draft = { base: loaded, current: loaded, revision: 0 };
    const commitDeps = recordsDeps(commit);

    const id = entryId();
    const written = writeJournalEntry(commitDeps)({ id, body: BODY, tags: ["tag1"] }, at(1));
    const changed = changedSessionRecords(commit.base, commit.current);

    expect(Result.isSuccess(written)).toBe(true);
    expect(sessionRecordsOf(commit.current)).toHaveLength(DAYS * SESSIONS_PER_DAY + 1);
    expect(changed.map(({ kind, session }) => ({ kind, id: session.id }))).toEqual([
      { kind: "Open", id: sessionId },
    ]);
    expect(changed[0]?.session.entries.map((stored) => stored.kind)).toEqual(["Written"]);
    // 閉じたセッションは書き込みの前と同じ値のまま残り、保存し直す対象にならない
    expect(commit.current.closed).toHaveLength(loaded.closed.length);
    expect(commit.current.closed.every((session, i) => session === loaded.closed[i])).toBe(true);
    // 保存し直すのは、書いたセッションの記録と進め方（メタ）の記録の2件
    const saved = [...changed.map(encodeSessionRecord), encodeMetaRecord(commit.current)];
    expect(saved).toHaveLength(2);
    expect(saved[0]).toContain(id);
  });
});
