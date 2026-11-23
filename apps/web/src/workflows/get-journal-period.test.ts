import { Result } from "@praha/byethrow";
import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import type { FindJournalEntriesWrittenIn } from "../domain/journal-calendar.ts";
import { JournalEntryId, type JournalEntry } from "../domain/journal-entry.ts";
import { Sensitive } from "../domain/sensitive.ts";
import { SessionId } from "../domain/session.ts";
import { getJournalPeriod } from "./get-journal-period.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const entryWrittenAt = (n: number, iso: string): JournalEntry => ({
  id: v.parse(JournalEntryId.schema, uuid(n)),
  sessionId: v.parse(SessionId.schema, uuid(100)),
  body: Sensitive.of("集中できた"),
  tags: [],
  writtenAt: new Date(iso),
  updatedAt: new Date(iso),
  writtenDuring: { kind: "Journal", round: 1, setNumber: 1 },
});

/** 書いた時刻が範囲に入る記入だけを返す記録先 */
const storeWith = (entries: ReadonlyArray<JournalEntry>) => ({
  findJournalEntriesWrittenIn: (({ from, until }) =>
    entries.filter(
      ({ writtenAt }) =>
        writtenAt.getTime() >= from.getTime() && writtenAt.getTime() < until.getTime(),
    )) satisfies FindJournalEntriesWrittenIn,
});

describe("期間のジャーナル記入", () => {
  test("期間の日付にその時間帯で書いた記入だけを、書いた日付と時刻を添えて返す", () => {
    // 東京の 10/12 は UTC の 10/11 15:00 から 10/12 15:00 まで
    const before = entryWrittenAt(1, "2026-10-11T14:59:00Z");
    const first = entryWrittenAt(2, "2026-10-11T15:00:00Z");
    const last = entryWrittenAt(3, "2026-10-12T14:59:00Z");
    const after = entryWrittenAt(4, "2026-10-12T15:00:00Z");

    const result = getJournalPeriod(storeWith([before, first, last, after]))({
      from: "2026-10-12",
      to: "2026-10-12",
      timeZone: "Asia/Tokyo",
    });

    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.unwrap(result).entries).toEqual([
      { ...first, writtenOn: "2026-10-12", writtenAtLocalTime: "00:00" },
      { ...last, writtenOn: "2026-10-12", writtenAtLocalTime: "23:59" },
    ]);
  });

  test("期間の始めが終わりより後なら失敗する", () => {
    const result = getJournalPeriod(storeWith([]))({
      from: "2026-10-13",
      to: "2026-10-12",
      timeZone: "Asia/Tokyo",
    });

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
  });
});
