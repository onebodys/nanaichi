import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import type { AdvanceMode } from "../domain/advance-mode.ts";
import { JournalEntryId, type JournalEntry } from "../domain/journal-entry.ts";
import { SessionId, type SessionSnapshot } from "../domain/session.ts";
import type { SessionOperation } from "../domain/session-event.ts";
import type { RecordsDeps } from "../device/records.ts";
import { settleAutoEnd } from "../workflows/auto-end-session.ts";
import { changeAdvanceMode } from "../workflows/change-advance-mode.ts";
import { deleteJournalEntry } from "../workflows/delete-journal-entry.ts";
import { deleteTag } from "../workflows/delete-tag.ts";
import { editJournalEntry } from "../workflows/edit-journal-entry.ts";
import { getAdvanceMode } from "../workflows/get-advance-mode.ts";
import { getCurrentSession } from "../workflows/get-current-session.ts";
import { getEntriesOnDate } from "../workflows/get-entries-on-date.ts";
import { getEntriesWithTag } from "../workflows/get-entries-with-tag.ts";
import { getJournalCalendar } from "../workflows/get-journal-calendar.ts";
import { getStats } from "../workflows/get-stats.ts";
import { getTagUsage } from "../workflows/get-tag-usage.ts";
import { getTags } from "../workflows/get-tags.ts";
import { getTimeline } from "../workflows/get-timeline.ts";
import { operateSession } from "../workflows/operate-session.ts";
import { startSession } from "../workflows/start-session.ts";
import { writeJournalEntry } from "../workflows/write-journal-entry.ts";

/** 空の記録先を用意し、その読み書きの契約で場面を1つ動かす */
export type FreshStore = (scene: (deps: RecordsDeps) => void) => Promise<void>;

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const at = (minutes: number, seconds = 0) => new Date(T0 + minutes * 60_000 + seconds * 1000);
const iso = (time: Date) => time.toISOString();

const uuid = () => crypto.randomUUID();
const entryId = () => v.parse(JournalEntryId.schema, uuid());

const succeeded = <T, E>(result: Result.Result<T, E>): T => {
  if (Result.isFailure(result)) {
    throw new Error(`成功するはずが失敗した: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

const failed = <T, E>(result: Result.Result<T, E>): E => {
  if (Result.isSuccess(result)) {
    throw new Error("失敗するはずが成功した");
  }
  return result.error;
};

const inSession = (snapshot: SessionSnapshot) => {
  if (snapshot.kind !== "Session") {
    throw new Error("セッションがあるはずがなかった");
  }
  return snapshot;
};

const mode = (
  focusToJournal: "Auto" | "Manual",
  journalToFocus: "Auto" | "Manual",
): AdvanceMode => ({
  FocusToJournal: focusToJournal,
  JournalToFocus: journalToFocus,
  JournalToBreak: "Auto",
  BreakToFocus: "Auto",
});

/** UserDO と同じ呼び方でワークフローを動かす（入力は HTTP の本文と同じ形） */
const operator = (deps: RecordsDeps) => {
  const run = <T>(now: Date, work: () => T): T => {
    const result = work();
    settleAutoEnd(deps)(now);
    return result;
  };
  return {
    start: (now: Date, id: string = uuid()) =>
      run(now, () =>
        startSession(deps)({ id }, now, v.parse(SessionId.schema, crypto.randomUUID())),
      ),
    operate: (now: Date, kind: SessionOperation["kind"], id: string = uuid()) =>
      run(now, () => operateSession(deps)({ id, kind }, now)),
    current: (now: Date) => run(now, () => getCurrentSession(deps)(now)),
    write: (
      now: Date,
      body: string,
      tags: ReadonlyArray<string> = [],
      id: JournalEntryId = entryId(),
    ) => run(now, () => writeJournalEntry(deps)({ id, body, tags }, now)),
    edit: (now: Date, id: JournalEntryId, body: string, tags: ReadonlyArray<string>) =>
      run(now, () => editJournalEntry(deps)(id, { body, tags }, now)),
    remove: (now: Date, id: JournalEntryId) => run(now, () => deleteJournalEntry(deps)(id, now)),
    deleteTag: (now: Date, name: string, deletion: unknown) =>
      run(now, () => deleteTag(deps)(name, deletion)),
    timeline: (now: Date, before?: Date) =>
      run(now, () => getTimeline(deps)(before === undefined ? {} : { before: iso(before) }, now)),
    tags: (now: Date) => run(now, () => getTags(deps)()),
    tagUsage: (now: Date) => run(now, () => getTagUsage(deps)()),
    entriesWithTag: (now: Date, tag: string, before?: Date) =>
      run(now, () =>
        getEntriesWithTag(deps)(before === undefined ? { tag } : { tag, before: iso(before) }),
      ),
    calendar: (now: Date, month: string) =>
      run(now, () => getJournalCalendar(deps)({ month, timeZone: "Asia/Tokyo" }, now)),
    entriesOnDate: (now: Date, date: string) =>
      run(now, () => getEntriesOnDate(deps)({ date, timeZone: "Asia/Tokyo" })),
    stats: (now: Date) =>
      run(now, () => getStats(deps)({ period: "All", timeZone: "Asia/Tokyo" }, now)),
    changeAdvanceMode: (now: Date, changed: AdvanceMode) =>
      run(now, () => changeAdvanceMode(deps)(changed, now)),
    advanceMode: (now: Date) => run(now, () => getAdvanceMode(deps)(now)),
  };
};

const idsOf = (entries: ReadonlyArray<JournalEntry>) => entries.map(({ id }) => id);

/** 期待する値は SQLite の振る舞いを仕様として書く（ADR 0019） */
export const storeContract = (freshStore: FreshStore): void => {
  describe("セッションと操作イベント", () => {
    test("同じミリ秒の操作は記録した順に操作イベントに並ぶ", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        succeeded(store.start(at(0)));
        succeeded(store.operate(at(5), "Pause"));
        succeeded(store.operate(at(5), "Resume"));

        const snapshot = inSession(store.current(at(6)));

        expect(snapshot.session.events.map(({ kind }) => kind)).toEqual([
          "Start",
          "Pause",
          "Resume",
        ]);
        expect(snapshot.state.kind).toBe("Focus");
      });
    });

    test("セッションは同時に1つしか開けず、同じ開始を送り直すと同じセッションが返る", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        const startId = uuid();
        const first = inSession(succeeded(store.start(at(0), startId)));

        expect(failed(store.start(at(1)))).toEqual({
          kind: "SessionAlreadyInProgress",
          sessionId: first.session.id,
        });
        const resent = inSession(succeeded(store.start(at(2), startId)));
        expect(resent.session.id).toBe(first.session.id);
        expect(resent.session.events).toHaveLength(1);
      });
    });

    test("終了したセッションは閉じ直されず、次のセッションを開始できる", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        const startId = uuid();
        const first = inSession(succeeded(store.start(at(0), startId)));
        succeeded(store.changeAdvanceMode(at(1), mode("Manual", "Auto")));
        succeeded(store.operate(at(2), "End"));
        succeeded(store.changeAdvanceMode(at(3), mode("Manual", "Manual")));
        const next = inSession(succeeded(store.start(at(4))));

        deps.closeSession(first.session.id, {
          kind: "Ended",
          endedAt: at(10),
          endedBy: "AutoEnd",
          completedSets: 0,
        });

        expect(inSession(store.current(at(11))).session.id).toBe(next.session.id);
        const replayed = inSession(succeeded(store.start(at(12), startId)));
        expect(replayed.state).toMatchObject({ kind: "Ended", endedBy: "End", endedAt: at(2) });
        expect(replayed.session.advanceModeChanges).toEqual([
          { at: at(1), mode: mode("Manual", "Auto") },
        ]);
      });
    });

    test("削除した記入も自動終了の時刻を延ばす", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        const startId = uuid();
        succeeded(store.start(at(0), startId));
        const entry = succeeded(store.write(at(30), "書いて消す"));
        succeeded(store.remove(at(31), entry.id));

        expect(store.current(at(87)).kind).toBe("Session");
        expect(store.current(at(89)).kind).toBe("NoSession");
        const replayed = inSession(succeeded(store.start(at(90), startId)));
        expect(replayed.state).toMatchObject({
          kind: "Ended",
          endedBy: "AutoEnd",
          endedAt: at(30),
        });
        expect(replayed.session.journalEntryTimes).toEqual([at(30)]);
      });
    });

    test("自動終了の時刻を過ぎると、記入しようとしたときに閉じてセッションの外になる", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        succeeded(store.start(at(0)));

        expect(failed(store.write(at(60), "遅すぎた"))).toEqual({ kind: "NoSessionInProgress" });
        expect(deps.findOpenSession()).toBeUndefined();
      });
    });
  });

  describe("フェーズの進め方", () => {
    test("同じミリ秒に2回変えると、あとに変えたほうが効く", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        succeeded(store.changeAdvanceMode(at(0), mode("Manual", "Auto")));
        succeeded(store.changeAdvanceMode(at(0), mode("Auto", "Manual")));

        expect(succeeded(store.advanceMode(at(1)))).toEqual(mode("Auto", "Manual"));
      });
    });

    test("セッションには始めた時刻に効いていた変更から含め、閉じたあとの変更は含めない", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        const startId = uuid();
        const before = { at: at(-10), mode: mode("Manual", "Auto") };
        const effective = { at: at(-5), mode: mode("Auto", "Manual") };
        const during = { at: at(1), mode: mode("Manual", "Manual") };
        const after = { at: at(3), mode: mode("Auto", "Auto") };
        succeeded(store.changeAdvanceMode(before.at, before.mode));
        succeeded(store.changeAdvanceMode(effective.at, effective.mode));
        succeeded(store.start(at(0), startId));
        succeeded(store.changeAdvanceMode(during.at, during.mode));

        expect(inSession(store.current(at(1, 30))).session.advanceModeChanges).toEqual([
          effective,
          during,
        ]);

        succeeded(store.operate(at(2), "End"));
        succeeded(store.changeAdvanceMode(after.at, after.mode));

        const replayed = inSession(succeeded(store.start(at(4), startId)));
        expect(replayed.session.advanceModeChanges).toEqual([effective, during]);
        // スタッツも閉じた時刻までの変更で計算する。取り込みで閉じた時刻の直後に足した行を、
        // 自動終了したセッションの操作として数えないため（ADR 0020）
        expect(deps.findStatsRecords().sessions.map((s) => s.advanceModeChanges)).toEqual([
          [effective, during],
        ]);
        expect(succeeded(store.advanceMode(at(5)))).toEqual(after.mode);
      });
    });
  });

  describe("ジャーナル記入", () => {
    test("同じ記入を送り直すと最初の記入が返り、削除した記入と同じ ID では書けない", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        succeeded(store.start(at(0)));
        const id = entryId();
        succeeded(store.write(at(1), "最初", [], id));

        const resent = succeeded(store.write(at(2), "送り直し", [], id));
        expect(resent.body.unwrap()).toBe("最初");
        expect(resent.writtenAt).toEqual(at(1));

        expect(succeeded(store.remove(at(3), id))).toEqual({ id, deletedAt: at(3) });
        expect(succeeded(store.remove(at(4), id))).toEqual({ id, deletedAt: at(3) });
        expect(failed(store.write(at(5), "もう一度", [], id)).kind).toBe("JournalEntryNotFound");
        expect(failed(store.edit(at(6), id, "直す", [])).kind).toBe("JournalEntryNotFound");
      });
    });

    test("終了したセッションの記入も編集でき、書いた時刻と紐付きは変わらない", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        succeeded(store.start(at(0)));
        const written = succeeded(store.write(at(1), "書いた", ["a"]));
        succeeded(store.operate(at(2), "End"));
        succeeded(store.start(at(5)));
        const inProgress = succeeded(store.write(at(6), "進行中"));

        const edited = succeeded(store.edit(at(10), written.id, "直した", ["b"]));

        expect(edited.writtenAt).toEqual(at(1));
        expect(edited.updatedAt).toEqual(at(10));
        expect(edited.writtenDuring).toEqual(written.writtenDuring);
        const [current, ended] = succeeded(store.timeline(at(11))).sessions;
        expect(idsOf(current?.entries ?? [])).toEqual([inProgress.id]);
        expect(ended?.entries.map((entry) => [entry.body.unwrap(), entry.tags])).toEqual([
          ["直した", ["b"]],
        ]);
        expect(ended?.entries[0]?.updatedAt).toEqual(at(10));
      });
    });

    test("カレンダーと選んだ日の記入は、範囲の始まりを含み終わりを含まず、削除した記入を除く", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        succeeded(store.start(at(0)));
        const first = succeeded(store.write(at(1), "1"));
        const second = succeeded(store.write(at(2), "2"));
        const removed = succeeded(store.write(at(2, 30), "消す"));
        const third = succeeded(store.write(at(3), "3"));
        succeeded(store.remove(at(4), removed.id));
        const window = { from: at(1), until: at(3) };

        // SQLite は並びを決めていないので、時刻の順に並べてから比べる
        expect(
          deps
            .findEntryTimesWrittenIn(window)
            .map((time) => time.getTime())
            .toSorted((a, b) => a - b),
        ).toEqual([at(1).getTime(), at(2).getTime()]);
        expect(idsOf(deps.findJournalEntriesWrittenIn(window))).toEqual([first.id, second.id]);

        const calendar = succeeded(store.calendar(at(5), "2026-11"));
        expect(calendar.days[1]).toMatchObject({ kind: "Day", entries: 3 });
        expect(idsOf(succeeded(store.entriesOnDate(at(5), "2026-11-02")).entries)).toEqual([
          first.id,
          second.id,
          third.id,
        ]);
      });
    });
  });

  describe("タイムライン", () => {
    test("開始の新しい順に進行中のセッションから1ページずつ返り、最後のページで続きがなくなる", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        const closed = Array.from({ length: 12 }, (_, i) => {
          const started = inSession(succeeded(store.start(at(i * 10))));
          succeeded(store.write(at(i * 10 + 1), `${i + 1}つ目`));
          succeeded(store.operate(at(i * 10 + 2), "End"));
          return started.session.id;
        });
        const inProgress = inSession(succeeded(store.start(at(130)))).session.id;
        const kept = succeeded(store.write(at(131), "残す"));
        const removed = succeeded(store.write(at(131, 30), "消す"));
        const later = succeeded(store.write(at(132), "あとで書いた"));
        succeeded(store.remove(at(133), removed.id));

        const latest = succeeded(store.timeline(at(134)));
        expect(latest.sessions.map(({ session }) => session.id)).toEqual([
          inProgress,
          ...closed.slice(3).toReversed(),
        ]);
        expect(idsOf(latest.sessions[0]?.entries ?? [])).toEqual([kept.id, later.id]);
        expect(latest.next).toEqual({ kind: "More", before: at(30) });

        const last = succeeded(store.timeline(at(135), at(30)));
        expect(last.sessions.map(({ session }) => session.id)).toEqual(
          closed.slice(0, 3).toReversed(),
        );
        expect(last.next).toEqual({ kind: "End" });
      });
    });
  });

  describe("タグ", () => {
    test("使っているタグは最近使った順、同じ時刻なら名前の順に並び、削除した記入のタグは数えない", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        succeeded(store.start(at(0)));
        succeeded(store.write(at(1), "1", ["a", "b"]));
        succeeded(store.write(at(2), "2", ["c", "b"]));
        const removed = succeeded(store.write(at(3), "3", ["d"]));
        succeeded(store.remove(at(4), removed.id));
        // SQLite は名前を UTF-8 のバイト順で並べる。UTF-16 で比べると U+E000 と絵文字の順が逆になる
        succeeded(store.write(at(5), "4", ["😀", ""]));

        expect(succeeded(store.tags(at(6))).tags).toEqual(["", "😀", "b", "c", "a"]);
        expect(succeeded(store.tagUsage(at(6))).tags).toEqual([
          { name: "", entryCount: 1 },
          { name: "😀", entryCount: 1 },
          { name: "b", entryCount: 2 },
          { name: "c", entryCount: 1 },
          { name: "a", entryCount: 1 },
        ]);
      });
    });

    test("削除した記入のタグは、使えるタグの種類の上限に数えない", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        succeeded(store.start(at(0)));
        const twenty = Array.from({ length: 20 }, (_, i) => `t${i + 1}`);
        const full = succeeded(store.write(at(1), "20種類", twenty));

        expect(failed(store.write(at(2), "21種類目", ["t21"])).kind).toBe("TagLimitExceeded");
        succeeded(store.edit(at(3), full.id, "入れ替え", [...twenty.slice(1), "t21"]));
        succeeded(store.remove(at(4), full.id));
        expect(succeeded(store.write(at(5), "空いた", ["t22"])).tags).toEqual(["t22"]);
      });
    });

    test("タグを外すと、ついていた記入からだけ外れ、記入の更新時刻は変わらない", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        succeeded(store.start(at(0)));
        const both = succeeded(store.write(at(1), "1", ["x", "y"]));
        const onlyY = succeeded(store.write(at(2), "2", ["y"]));
        const onlyX = succeeded(store.write(at(3), "3", ["x"]));

        succeeded(store.deleteTag(at(4), "x", { kind: "Detach" }));

        expect(succeeded(store.tags(at(5))).tags).toEqual(["y"]);
        const [entries] = succeeded(store.timeline(at(5))).sessions.map((s) => s.entries);
        expect(entries?.map(({ id, tags, updatedAt }) => ({ id, tags, updatedAt }))).toEqual([
          { id: both.id, tags: ["y"], updatedAt: at(1) },
          { id: onlyY.id, tags: ["y"], updatedAt: at(2) },
          { id: onlyX.id, tags: [], updatedAt: at(3) },
        ]);
      });
    });

    test("タグを付け替えると、付け替え先がすでについている記入では1つにまとまる", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        succeeded(store.start(at(0)));
        succeeded(store.write(at(1), "1", ["x", "y"]));
        succeeded(store.write(at(2), "2", ["x"]));
        succeeded(store.write(at(3), "3", ["z"]));

        expect(
          failed(store.deleteTag(at(4), "x", { kind: "Reassign", to: "unused" })),
        ).toMatchObject({ kind: "TagNotFound" });
        succeeded(store.deleteTag(at(5), "x", { kind: "Reassign", to: "y" }));

        expect(succeeded(store.tagUsage(at(6))).tags).toEqual([
          { name: "z", entryCount: 1 },
          { name: "y", entryCount: 2 },
        ]);
        const page = succeeded(store.entriesWithTag(at(6), "y"));
        expect(page.entries.map(({ tags }) => tags)).toEqual([["y"], ["y"]]);
      });
    });

    test("タグのついた記入は書いた時刻の新しい順に1ページずつ返り、最後のページで続きがなくなる", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        succeeded(store.start(at(0)));
        const tagged = Array.from({ length: 22 }, (_, i) =>
          succeeded(store.write(at(i + 1), `${i + 1}`, ["t"])),
        );
        const removed = succeeded(store.write(at(23), "消す", ["t"]));
        succeeded(store.remove(at(24), removed.id));
        succeeded(store.write(at(25), "タグなし"));

        const latest = succeeded(store.entriesWithTag(at(26), "t"));
        expect(idsOf(latest.entries)).toEqual(idsOf(tagged.slice(2).toReversed()));
        expect(latest.next).toEqual({ kind: "More", before: at(3) });

        const last = succeeded(store.entriesWithTag(at(26), "t", at(3)));
        expect(idsOf(last.entries)).toEqual(idsOf(tagged.slice(0, 2).toReversed()));
        expect(last.next).toEqual({ kind: "End" });
      });
    });
  });

  describe("スタッツ", () => {
    test("数えるもとの記録は削除した記入を除き、自動終了の判断に使う記入の時刻には含める", async () => {
      await freshStore((deps) => {
        const store = operator(deps);
        const first = inSession(succeeded(store.start(at(0)))).session.id;
        succeeded(store.write(at(1), "残す", ["a"]));
        const removed = succeeded(store.write(at(2), "消す", ["b"]));
        succeeded(store.remove(at(3), removed.id));
        succeeded(store.operate(at(4), "End"));
        const second = inSession(succeeded(store.start(at(10)))).session.id;
        succeeded(store.write(at(11), "進行中"));

        const records = deps.findStatsRecords();
        // SQLite はセッションを ID の順に返す。順は数え方に影響しないので、開始の順に並べてから比べる
        const sessions = records.sessions.toSorted(
          (a, b) => a.events[0].at.getTime() - b.events[0].at.getTime(),
        );
        expect(sessions.map(({ id, journalEntryTimes }) => ({ id, journalEntryTimes }))).toEqual([
          { id: first, journalEntryTimes: [at(1), at(2)] },
          { id: second, journalEntryTimes: [at(11)] },
        ]);
        expect(records.entries).toEqual([
          {
            sessionId: first,
            writtenAt: at(1),
            writtenDuring: { kind: "Focus", round: 1, setNumber: 1 },
            tags: ["a"],
          },
          {
            sessionId: second,
            writtenAt: at(11),
            writtenDuring: { kind: "Focus", round: 1, setNumber: 1 },
            tags: [],
          },
        ]);
        expect(succeeded(store.stats(at(12))).activity).toMatchObject({
          kind: "Active",
          entries: 2,
        });
      });
    });
  });
};
