import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { JournalEntry, JournalEntryBody, JournalEntryId } from "./journal-entry.ts";
import { schemaResult } from "./schema-result.ts";
import { SessionEventId } from "./session-event.ts";
import { Session, SessionId } from "./session.ts";
import { SyncMessage, SyncMessageJsonSchema } from "./sync-message.ts";

const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
const at = (minutes: number) => new Date(STARTED_AT + minutes * 60_000);

const started = Session.start(
  v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000000"),
  v.parse(SessionEventId.schema, "00000000-0000-4000-8000-000000000001"),
  at(0),
);

const written = Result.unwrap(
  JournalEntry.write({
    id: v.parse(JournalEntryId.schema, "00000000-0000-4000-8000-000000000002"),
    body: v.parse(JournalEntryBody.schema, "設計を書いた"),
    tags: [],
    sessionId: started.id,
    state: Session.stateAt(started, at(3)),
    now: at(3),
  }),
);

/** 送った文字列を、画面と同じく JSON にしてからスキーマで検証する */
const receive = (sent: string) => schemaResult(SyncMessageJsonSchema)(JSON.parse(sent));

describe("同期メッセージの送受信", () => {
  test("セッションが変わったら、スナップショットを時刻を Date に戻して受け取れる", () => {
    const message: SyncMessage = {
      kind: "SessionChanged",
      snapshot: Session.snapshot(started, at(3)),
    };

    expect(receive(SyncMessage.serialize(message))).toEqual(Result.succeed(message));
  });

  test("記入を書いたら、本文を取り出して送り、受け取る側でまた PII として包む", () => {
    const sent = SyncMessage.serialize({ kind: "JournalEntrySaved", entry: written });

    expect(JSON.parse(sent)).toMatchObject({ entry: { body: "設計を書いた" } });
    const received = receive(sent);
    expect(Result.isSuccess(received) && received.value).toMatchObject({
      kind: "JournalEntrySaved",
      entry: { id: written.id, writtenAt: at(3), writtenDuring: written.writtenDuring },
    });
    expect(
      Result.isSuccess(received) &&
        received.value.kind === "JournalEntrySaved" &&
        received.value.entry.body.unwrap(),
    ).toBe("設計を書いた");
  });

  test("記入を削除したら、削除した記入の ID と時刻を受け取れる", () => {
    const message: SyncMessage = {
      kind: "JournalEntryDeleted",
      deleted: { id: written.id, deletedAt: at(4) },
    };

    expect(receive(SyncMessage.serialize(message))).toEqual(Result.succeed(message));
  });

  test("知らない種類のメッセージは検証で失敗する", () => {
    expect(Result.isFailure(receive(JSON.stringify({ kind: "Unknown" })))).toBe(true);
  });
});
