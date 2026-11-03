import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import {
  AdvanceMode,
  AdvanceModeChange,
  type AdvanceModeChange as Change,
} from "./advance-mode.ts";
import {
  Import,
  IMPORT_BATCH_MAX_SESSIONS,
  ImportBatch,
  ImportBatchJsonSchema,
  ImportReceiptJsonSchema,
  type AccountRecords,
  type ImportReceipt,
} from "./import.ts";
import { JournalEntryId } from "./journal-entry.ts";
import { schemaResult } from "./schema-result.ts";
import { Sensitive } from "./sensitive.ts";
import { SessionEventId } from "./session-event.ts";
import { SessionRecord, type ClosedSession, type StoredEntry } from "./session-record.ts";
import { Session, SessionId } from "./session.ts";

const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const uuid = () => crypto.randomUUID();

const manual = { ...AdvanceMode.default, FocusToJournal: "Manual" } as const satisfies AdvanceMode;
const allManual = {
  FocusToJournal: "Manual",
  JournalToFocus: "Manual",
  JournalToBreak: "Manual",
  BreakToFocus: "Manual",
} as const satisfies AdvanceMode;
const auto = AdvanceMode.default;

const own: AccountRecords = { kind: "HasOwnRecords" };
const onlyImported: AccountRecords = { kind: "OnlyImported" };

/** `startMinute` に始めて `endMinute` に終えた閉じたセッション。`written` は記入を書いた分 */
const closedSession = (
  startMinute: number,
  endMinute: number,
  options: Readonly<{
    endedBy?: ClosedSession["endedBy"];
    written?: ReadonlyArray<number>;
    deleted?: ReadonlyArray<number>;
    body?: string;
  }> = {},
): ClosedSession => {
  const id = v.parse(SessionId.schema, uuid());
  const endedBy = options.endedBy ?? "End";
  const written = (options.written ?? []).map((minute): StoredEntry => ({
    kind: "Written",
    entry: {
      id: v.parse(JournalEntryId.schema, uuid()),
      sessionId: id,
      body: Sensitive.of(options.body ?? "書いたこと"),
      tags: [],
      writtenAt: at(minute),
      updatedAt: at(minute),
      writtenDuring: { kind: "Journal", round: 1, setNumber: 1 },
    },
  }));
  const deleted = (options.deleted ?? []).map((minute): StoredEntry => ({
    kind: "Deleted",
    deleted: { id: v.parse(JournalEntryId.schema, uuid()), deletedAt: at(minute + 1) },
    sessionId: id,
    writtenAt: at(minute),
  }));
  const start = {
    kind: "Start",
    id: v.parse(SessionEventId.schema, uuid()),
    at: at(startMinute),
  } as const;
  return {
    id,
    events:
      endedBy === "End"
        ? [start, { kind: "End", id: v.parse(SessionEventId.schema, uuid()), at: at(endMinute) }]
        : [start],
    entries: [...written, ...deleted],
    endedAt: at(endMinute),
    endedBy,
  };
};

/** 足した行を SQLite と同じく同じ時刻の行の後ろに並べる（`ORDER BY changed_at, rowid`） */
const merged = (existing: ReadonlyArray<Change>, rows: ReadonlyArray<Change>) =>
  [...existing, ...rows].toSorted((a, b) => a.at.getTime() - b.at.getTime());

const afterMs = (date: Date, ms: number) => new Date(date.getTime() + ms);

/**
 * サーバーと端末が閉じたセッションを計算するときと同じ形。進め方の履歴は終わった時刻までを読む
 * （sessionLoader、stats-sqlite.ts、records.ts）
 */
const sessionComputedWith = (session: ClosedSession, history: ReadonlyArray<Change>): Session => ({
  id: session.id,
  events: session.events,
  journalEntryTimes: session.entries
    .map((stored) => (stored.kind === "Written" ? stored.entry.writtenAt : stored.writtenAt))
    .toSorted((a, b) => a.getTime() - b.getTime()),
  advanceModeChanges: AdvanceModeChange.relevantSince(history, session.events[0].at).filter(
    (change) => change.at.getTime() <= session.endedAt.getTime(),
  ),
});

describe("取り込むセッションの時間の重なり", () => {
  const span = (from: number, to: number) => Import.spanOf(closedSession(from, to));

  test("終わった時刻と始めた時刻が同じセッションは、重なるとみなす", () => {
    expect(Import.overlaps(span(0, 30), span(30, 60))).toBe(true);
    expect(Import.overlaps(span(30, 60), span(0, 30))).toBe(true);
  });

  test("時間が離れているセッションは重ならない", () => {
    expect(Import.overlaps(span(0, 30), span(31, 60))).toBe(false);
    expect(Import.overlaps(span(31, 60), span(0, 30))).toBe(false);
  });

  test("一方がもう一方の中に収まるセッションは重なる", () => {
    expect(Import.overlaps(span(0, 60), span(10, 20))).toBe(true);
  });

  test("開いているセッションとは、始めた時刻より後に終わるセッションが重なる", () => {
    const open = { kind: "Open", startedAt: at(30) } as const;

    expect(Import.overlaps(span(40, 50), open)).toBe(true);
    expect(Import.overlaps(span(0, 30), open)).toBe(true);
    expect(Import.overlaps(span(0, 29), open)).toBe(false);
  });
});

describe("取り込むセッションの進め方の行", () => {
  test("端末で進め方を変えたことがなければ、進め方の行を足さない", () => {
    const session = closedSession(0, 30);

    expect(Import.advanceModeRows({ session, device: [], existing: [], account: own })).toEqual([]);
    expect(
      Import.advanceModeRows({ session, device: [], existing: [], account: onlyImported }),
    ).toEqual([]);
  });

  test("始めた時刻に端末で効いていた進め方がアカウントと違えば、始めた時刻に行を足す", () => {
    const session = closedSession(0, 30);
    const device = [{ at: at(-100), mode: manual }];

    expect(
      Import.advanceModeRows({ session, device, existing: [], account: onlyImported }),
    ).toEqual([{ at: at(0), mode: manual }]);
  });

  test("始めた時刻の進め方がアカウントと同じなら、始めた時刻の行は足さない", () => {
    const session = closedSession(0, 30);
    const device = [{ at: at(-100), mode: manual }];
    const existing = [{ at: at(-500), mode: manual }];

    expect(Import.advanceModeRows({ session, device, existing, account: own })).toEqual([]);
  });

  test("セッションの間に端末で変えた進め方は、変えた時刻のまま足し、セッションの外の変更は足さない", () => {
    const session = closedSession(0, 30);
    const device = [
      { at: at(-100), mode: manual },
      { at: at(10), mode: auto },
      { at: at(20), mode: manual },
      { at: at(40), mode: allManual },
    ];

    expect(
      Import.advanceModeRows({ session, device, existing: [], account: onlyImported }),
    ).toEqual([
      { at: at(0), mode: manual },
      { at: at(10), mode: auto },
      { at: at(20), mode: manual },
    ]);
  });

  test("セッションの間の端末の変更は、効いている進め方を変えなくても足す（自動終了の判断で操作として数える）", () => {
    const session = closedSession(0, 30);
    const device = [{ at: at(15), mode: auto }];

    expect(
      Import.advanceModeRows({ session, device, existing: [], account: onlyImported }),
    ).toEqual([{ at: at(15), mode: auto }]);
  });

  test("アカウントに取り込み以外の記録があれば、終わった時刻にアカウントの進め方へ戻す行を足す", () => {
    const session = closedSession(0, 30);
    const device = [{ at: at(-100), mode: manual }];
    const existing = [{ at: at(-500), mode: allManual }];

    expect(Import.advanceModeRows({ session, device, existing, account: own })).toEqual([
      { at: at(0), mode: manual },
      { at: new Date(at(30).getTime() + 1), mode: allManual },
    ]);
  });

  test("アカウントに取り込み以外の記録がなければ、戻す行を足さない", () => {
    const session = closedSession(0, 30);
    const device = [{ at: at(-100), mode: manual }];
    const existing = [{ at: at(-500), mode: allManual }];

    expect(Import.advanceModeRows({ session, device, existing, account: onlyImported })).toEqual([
      { at: at(0), mode: manual },
    ]);
  });

  test("セッションの間の変更でアカウントの進め方に戻っていれば、戻す行を足さない", () => {
    const session = closedSession(0, 30);
    const device = [
      { at: at(-100), mode: manual },
      { at: at(20), mode: auto },
    ];

    expect(Import.advanceModeRows({ session, device, existing: [], account: own })).toEqual([
      { at: at(0), mode: manual },
      { at: at(20), mode: auto },
    ]);
  });

  describe("取り込み以外の記録があるとき、取り込んだセッションの外の時刻に効いている進め方は変わらない", () => {
    const histories: ReadonlyArray<
      readonly [string, ReadonlyArray<Change>, ReadonlyArray<Change>]
    > = [
      ["どちらも変えていない", [], []],
      ["端末だけ変えた", [{ at: at(-100), mode: manual }], []],
      ["アカウントだけ変えた", [], [{ at: at(-100), mode: manual }]],
      [
        "両方が違う時刻に変えた",
        [
          { at: at(-50), mode: allManual },
          { at: at(10), mode: auto },
          { at: at(30), mode: manual },
        ],
        [
          { at: at(-200), mode: manual },
          { at: at(100), mode: auto },
        ],
      ],
      [
        "アカウントがセッションの間に変えた",
        [{ at: at(5), mode: allManual }],
        [{ at: at(15), mode: manual }],
      ],
      [
        "アカウントが終わった時刻の直後に変えた",
        [{ at: at(-100), mode: manual }],
        [{ at: afterMs(at(30), 1), mode: allManual }],
      ],
      [
        "同じ時刻に変えた",
        [{ at: at(0), mode: manual }],
        [
          { at: at(0), mode: allManual },
          { at: at(30), mode: auto },
        ],
      ],
    ];
    const probes = [-1000, -200, -100, -50, -1, 31, 50, 100, 101, 10_000];

    test.each(histories)("%s", (_, device, existing) => {
      const session = closedSession(0, 30);
      const rows = Import.advanceModeRows({ session, device, existing, account: own });
      const after = merged(existing, rows);

      const times = [...probes.map(at), afterMs(at(0), -1), afterMs(at(30), 1)];
      for (const time of times) {
        expect(AdvanceModeChange.modeAt(after, time)).toEqual(
          AdvanceModeChange.modeAt(existing, time),
        );
      }
    });
  });
});

describe("取り込んだセッションの計算", () => {
  const device = [
    { at: at(-100), mode: manual },
    { at: at(3), mode: allManual },
  ];
  /** 自動終了したセッションの終わった時刻は、端末で計算した自動終了の時刻（最後の記入か操作の時刻） */
  const autoEnded = (written: ReadonlyArray<number>): ClosedSession => {
    const open = closedSession(0, 10_000, { endedBy: "AutoEnd", written });
    const state = Session.stateAt(sessionComputedWith(open, device), at(10_000));
    if (state.kind !== "Ended") {
      throw new Error("自動終了していない");
    }
    return { ...open, endedAt: state.endedAt };
  };
  const cases: ReadonlyArray<readonly [string, ClosedSession]> = [
    ["終了したセッション", closedSession(0, 30, { written: [8] })],
    ["自動終了したセッション", autoEnded([])],
    ["記入のあとで自動終了したセッション", autoEnded([10])],
  ];

  test.each(cases)(
    "%sは、取り込み以外の記録があるアカウントでも端末で計算したものと同じ状態になる",
    (_, session) => {
      const existing = [{ at: at(-500), mode: auto }];
      const rows = Import.advanceModeRows({ session, device, existing, account: own });
      const onDevice = sessionComputedWith(session, device);
      const onAccount = sessionComputedWith(session, merged(existing, rows));
      const endedAt = session.endedAt;

      // 戻す行は終わった時刻の 1 ミリ秒後なので、閉じたセッションの計算に入らない
      expect(rows.at(-1)).toEqual({ at: afterMs(endedAt, 1), mode: auto });
      const times = [
        ...[0, 3, 5, 7, 8, 20, 30, 57, 58, 68].map(at),
        afterMs(endedAt, -1),
        endedAt,
        afterMs(endedAt, 1),
        afterMs(endedAt, 60_000),
        at(10_000),
      ];
      for (const time of times) {
        expect(Session.stateAt(onAccount, time)).toEqual(Session.stateAt(onDevice, time));
      }
      expect(Session.stateAt(onAccount, at(10_000))).toMatchObject({
        kind: "Ended",
        endedBy: session.endedBy,
        endedAt,
      });
      expect(Session.setOutcomesAt(onAccount, at(10_000))).toEqual(
        Session.setOutcomesAt(onDevice, at(10_000)),
      );
      expect(Session.autoEndDueAt(onAccount)).toEqual(Session.autoEndDueAt(onDevice));
    },
  );
});

describe("アカウントのいまの進め方", () => {
  test("取り込み以外の記録がなければ、端末のいまの進め方にする", () => {
    expect(
      Import.currentModeRows({
        account: onlyImported,
        existing: [{ at: at(0), mode: manual }],
        device: [{ at: at(-10), mode: allManual }],
        now: at(100),
      }),
    ).toEqual([{ at: at(100), mode: allManual }]);
  });

  test("端末のいまの進め方と同じなら、もう足さない（やり直しても増えない）", () => {
    const device = [{ at: at(-10), mode: allManual }];
    const first = Import.currentModeRows({
      account: onlyImported,
      existing: [],
      device,
      now: at(100),
    });

    expect(
      Import.currentModeRows({ account: onlyImported, existing: first, device, now: at(200) }),
    ).toEqual([]);
  });

  test("端末で変えたことがなく、アカウントも既定なら足さない", () => {
    expect(
      Import.currentModeRows({ account: onlyImported, existing: [], device: [], now: at(100) }),
    ).toEqual([]);
  });

  test("履歴の最後の行がいまより後なら、その時刻に足す", () => {
    expect(
      Import.currentModeRows({
        account: onlyImported,
        existing: [{ at: at(500), mode: manual }],
        device: [],
        now: at(100),
      }),
    ).toEqual([{ at: at(500), mode: auto }]);
  });

  test("取り込み以外の記録があれば、アカウントの進め方のままにする", () => {
    expect(
      Import.currentModeRows({
        account: own,
        existing: [],
        device: [{ at: at(-10), mode: allManual }],
        now: at(100),
      }),
    ).toEqual([]);
  });
});

describe("取り込みの束", () => {
  test("束は件数の上限で分け、順を保つ", () => {
    const sessions = Array.from({ length: IMPORT_BATCH_MAX_SESSIONS * 2 + 1 }, (_, i) =>
      closedSession(i * 60, i * 60 + 30),
    );

    const batches = Import.batches(sessions, []);

    expect(batches.map((batch) => batch.sessions.length)).toEqual([
      IMPORT_BATCH_MAX_SESSIONS,
      IMPORT_BATCH_MAX_SESSIONS,
      1,
    ]);
    expect(batches.flatMap((batch) => batch.sessions)).toEqual(sessions);
  });

  test("束は大きさの上限で分け、上限より大きいセッションは1つだけの束にする", () => {
    const body = "あ".repeat(9_000);
    const big = closedSession(0, 30, {
      written: Array.from({ length: 120 }, (_, i) => 1 + i * 0.1),
      body,
    });
    const smalls = Array.from({ length: 30 }, (_, i) =>
      closedSession(100 + i * 60, 130 + i * 60, {
        written: Array.from({ length: 6 }, (_, j) => 101 + i * 60 + j),
        body,
      }),
    );

    const batches = Import.batches([...smalls.slice(0, 10), big, ...smalls.slice(10)], []);
    const sizes = batches.map((batch) => JSON.stringify(ImportBatch.toJson(batch)).length);

    expect(batches.find((batch) => batch.sessions.includes(big))?.sessions).toEqual([big]);
    expect(sizes.filter((size) => size > 1_000_000)).toHaveLength(1);
    expect(batches.length).toBeGreaterThan(2);
    expect(batches.flatMap((batch) => batch.sessions)).toHaveLength(31);
  });

  test("どの束にも端末の進め方の履歴を全部持たせる", () => {
    const history = [
      { at: at(-100), mode: manual },
      { at: at(5_000), mode: auto },
    ];
    const sessions = Array.from({ length: IMPORT_BATCH_MAX_SESSIONS + 1 }, (_, i) =>
      closedSession(i * 60, i * 60 + 30),
    );

    expect(Import.batches(sessions, history).map((batch) => batch.advanceModeChanges)).toEqual([
      history,
      history,
    ]);
  });

  test("閉じたセッションがなければ、束を作らない", () => {
    expect(Import.batches([], [{ at: at(0), mode: manual }])).toEqual([]);
  });
});

describe("取り込みの束の検証", () => {
  const parse = schemaResult(ImportBatchJsonSchema);
  const overTheWire = (json: unknown): unknown => JSON.parse(JSON.stringify(json));

  test("送る形にした束を検証すると、同じセッションと履歴に戻る", () => {
    const batch = {
      sessions: [closedSession(0, 30, { written: [8], deleted: [9] })],
      advanceModeChanges: [{ at: at(-1), mode: manual }],
    };

    const parsed = parse(overTheWire(ImportBatch.toJson(batch)));

    expect(Result.isSuccess(parsed) && overTheWire(ImportBatch.toJson(parsed.value))).toEqual(
      overTheWire(ImportBatch.toJson(batch)),
    );
  });

  test("開いているセッションの記録を含む束は、検証に失敗する", () => {
    const closed = closedSession(0, 30);
    const open = SessionRecord.toJson({ kind: "Open", session: closed });

    expect(parse(overTheWire({ sessions: [open], advanceModeChanges: [] }))).toMatchObject({
      type: "Failure",
    });
  });

  test("終わった時刻が始めた時刻より前のセッションは、検証に失敗する", () => {
    const backwards = { ...closedSession(30, 30), endedAt: at(10) };

    expect(
      parse(overTheWire(ImportBatch.toJson({ sessions: [backwards], advanceModeChanges: [] }))),
    ).toMatchObject({ type: "Failure" });
  });

  test("セッションのない束と、上限より多いセッションの束は、検証に失敗する", () => {
    const many = Array.from({ length: IMPORT_BATCH_MAX_SESSIONS + 1 }, (_, i) =>
      closedSession(i * 60, i * 60 + 30),
    );

    expect(parse(overTheWire({ sessions: [], advanceModeChanges: [] }))).toMatchObject({
      type: "Failure",
    });
    expect(
      parse(overTheWire(ImportBatch.toJson({ sessions: many, advanceModeChanges: [] }))),
    ).toMatchObject({ type: "Failure" });
  });

  test("時刻の順に並んでいない進め方の履歴は、検証に失敗する", () => {
    const batch = {
      sessions: [closedSession(0, 30)],
      advanceModeChanges: [
        { at: at(10), mode: manual },
        { at: at(5), mode: auto },
      ],
    };

    expect(parse(overTheWire(ImportBatch.toJson(batch)))).toMatchObject({ type: "Failure" });
  });
});

describe("取り込みの応答の検証", () => {
  test("セッションごとの結果を検証して戻す", () => {
    const receipt: ImportReceipt = {
      outcomes: [
        { sessionId: v.parse(SessionId.schema, uuid()), kind: "Imported" },
        { sessionId: v.parse(SessionId.schema, uuid()), kind: "AlreadyImported" },
        { sessionId: v.parse(SessionId.schema, uuid()), kind: "Overlapping" },
      ],
    };

    expect(schemaResult(ImportReceiptJsonSchema)(JSON.parse(JSON.stringify(receipt)))).toEqual(
      Result.succeed(receipt),
    );
  });
});

describe("取り込みのダイアログに出す数", () => {
  test("削除した記入は数えない", () => {
    const sessions = [
      closedSession(0, 30, { written: [1, 2], deleted: [3] }),
      closedSession(60, 90, { deleted: [61] }),
    ];

    expect(Import.summaryOf(sessions)).toEqual({ sessions: 2, entries: 2 });
  });
});
