import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { JournalEntry, JournalEntryBody, JournalEntryId } from "../domain/journal-entry.ts";
import { SessionEventId } from "../domain/session-event.ts";
import { Session, SessionId } from "../domain/session.ts";
import { Timeline } from "../domain/timeline.ts";
import { mergeLatestPage } from "./timeline-changes.ts";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 18, 0, minutes));
const started = Session.start(
  v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000000"),
  v.parse(SessionEventId.schema, "00000000-0000-4000-8000-000000000001"),
  at(0),
);
const entry = Result.unwrap(
  JournalEntry.write({
    id: v.parse(JournalEntryId.schema, "00000000-0000-4000-8000-0000000000e1"),
    body: v.parse(JournalEntryBody.schema, "PC で書いた記入"),
    tags: [],
    sessionId: started.id,
    state: Session.stateAt(started, at(3)),
    now: at(3),
  }),
);

/** 記入を書く前に読んだページ（記入はまだない） */
const stalePage = [{ session: started, entries: [] }];

describe("読み込み直したタイムラインのページを重ねる", () => {
  test("読み込んでいる間に届いた記入は、それより前に読んだページで置き換えても消えない", () => {
    const received = Timeline.putEntry(stalePage, entry);

    const merged = mergeLatestPage(received, stalePage, [
      (sessions) => Timeline.putEntry(sessions, entry),
    ]);

    expect(merged[0]?.entries).toEqual([entry]);
  });

  test("読み込んでいる間に届いた削除は、それより前に読んだページに記入があっても消えたまま", () => {
    const pageWithEntry = [{ session: started, entries: [entry] }];

    const merged = mergeLatestPage(stalePage, pageWithEntry, [
      (sessions) => Timeline.removeEntry(sessions, entry.id),
    ]);

    expect(merged[0]?.entries).toEqual([]);
  });

  test("読み込み始める前の変更はページに含まれているので、ページの内容になる", () => {
    const pageWithEntry = [{ session: started, entries: [entry] }];

    expect(mergeLatestPage(stalePage, pageWithEntry, [])[0]?.entries).toEqual([entry]);
  });
});
