import * as v from "valibot";
import { AdvanceMode, AdvanceModeChange, AdvanceModeChangeJsonSchema } from "./advance-mode.ts";
import {
  ClosedSessionRecordJsonSchema,
  SessionRecord,
  type ClosedSession,
  type SessionRecordJson,
} from "./session-record.ts";
import { SessionId } from "./session.ts";

// ---------------------------------------------------------------------------
// 取り込みの束（`POST /api/imports` の本文、ADR 0020）
// ---------------------------------------------------------------------------

/** 1つの束に入れるセッションの数の上限 */
export const IMPORT_BATCH_MAX_SESSIONS = 100;

/** 1つの束の大きさの目安（JSON の文字数）。1件で超えるセッションは、そのセッションだけの束にする */
const IMPORT_BATCH_MAX_CHARS = 1_000_000;

/** 束に入れられる進め方の変更の数の上限。変更は人が進め方を切り替えるたびに1件なので、十分に大きい */
const ADVANCE_MODE_CHANGES_MAX = 10_000;

/** 1回の `POST /api/imports` の本文 */
export type ImportBatch = Readonly<{
  /** 閉じたセッション。この端末の記録の順（始めた時刻の順） */
  sessions: ReadonlyArray<ClosedSession>;
  /**
   * この端末の進め方の変更履歴の全部（時刻の順）。どの行をアカウントに足すかはサーバーが決める。
   * 端末のいまの進め方は、この履歴の最後の行（なければ既定）
   */
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>;
}>;

/** JSON にした束。本文は取り出してある */
export type ImportBatchJson = Readonly<{
  sessions: ReadonlyArray<SessionRecordJson>;
  advanceModeChanges: ReadonlyArray<AdvanceModeChange>;
}>;

const isInTimeOrder = (changes: ReadonlyArray<AdvanceModeChange>): boolean =>
  changes.every((change, i) => {
    const previous = changes[i - 1];
    return previous === undefined || previous.at.getTime() <= change.at.getTime();
  });

/** 束を検証して戻す。開いているセッションが1つでもあれば、束全体が検証の失敗になる */
export const ImportBatchJsonSchema: v.GenericSchema<unknown, ImportBatch> = v.object({
  sessions: v.pipe(
    v.array(ClosedSessionRecordJsonSchema),
    v.minLength(1),
    v.maxLength(IMPORT_BATCH_MAX_SESSIONS),
  ),
  advanceModeChanges: v.pipe(
    v.array(AdvanceModeChangeJsonSchema),
    v.maxLength(ADVANCE_MODE_CHANGES_MAX),
    v.check((changes) => isInTimeOrder(changes), "進め方の変更が時刻の順に並んでいない"),
  ),
});

export const ImportBatch = {
  /** 送る形。`Import.batches` が大きさを見積もるのにも使うので、見積もりと送るものがずれない */
  toJson: (batch: ImportBatch): ImportBatchJson => ({
    sessions: batch.sessions.map((session) => SessionRecord.toJson({ kind: "Closed", session })),
    advanceModeChanges: batch.advanceModeChanges,
  }),
} as const;

// ---------------------------------------------------------------------------
// 取り込みの応答
// ---------------------------------------------------------------------------

/**
 * セッションごとの結果（ADR 0020）。この端末は `Imported` と `AlreadyImported` だけを消す。
 *
 * - `Imported`: 受け取ってアカウントに書いた
 * - `AlreadyImported`: 同じ ID のセッションがアカウントにすでにある。上書きしていない
 * - `Overlapping`: アカウントのセッションと時間が重なるので書いていない
 */
export type SessionImportOutcome = Readonly<{
  sessionId: SessionId;
  kind: "Imported" | "AlreadyImported" | "Overlapping";
}>;

/** `POST /api/imports` の応答。束のセッションと同じ順 */
export type ImportReceipt = Readonly<{ outcomes: ReadonlyArray<SessionImportOutcome> }>;

export const ImportReceiptJsonSchema: v.GenericSchema<unknown, ImportReceipt> = v.object({
  outcomes: v.array(
    v.object({
      sessionId: SessionId.schema,
      kind: v.picklist(["Imported", "AlreadyImported", "Overlapping"]),
    }),
  ),
});

// ---------------------------------------------------------------------------
// 判断
// ---------------------------------------------------------------------------

/**
 * アカウントの側の記録の状態。取り込みで足した行には印をつけて判断するので、束を分けても、
 * やり直しても変わらない（ADR 0020）
 *
 * - `OnlyImported`: 空のアカウント、または取り込みで足した記録だけ
 * - `HasOwnRecords`: 取り込みで足したのではないセッションか進め方の変更がある
 */
export type AccountRecords =
  | Readonly<{ kind: "OnlyImported" }>
  | Readonly<{ kind: "HasOwnRecords" }>;

/** セッションの時間の範囲。開いているセッションには終わりがない */
export type SessionSpan =
  | Readonly<{ kind: "Closed"; startedAt: Date; endedAt: Date }>
  | Readonly<{ kind: "Open"; startedAt: Date }>;

/** 取り込むセッションの範囲。取り込めるのは閉じたセッションだけ */
export type ClosedSessionSpan = Extract<SessionSpan, { kind: "Closed" }>;

/** 取り込みのダイアログに出す数 */
export type ImportSummary = Readonly<{ sessions: number; entries: number }>;

const endOf = (span: SessionSpan): number => {
  switch (span.kind) {
    case "Closed":
      return span.endedAt.getTime();
    case "Open":
      return Number.POSITIVE_INFINITY;
  }
};

/** 足した行は、同じ時刻の行の後ろに並ぶ（SQLite の `ORDER BY changed_at, rowid`）。`toSorted` は安定 */
const withRows = (
  existing: ReadonlyArray<AdvanceModeChange>,
  rows: ReadonlyArray<AdvanceModeChange>,
): ReadonlyArray<AdvanceModeChange> =>
  [...existing, ...rows].toSorted((a, b) => a.at.getTime() - b.at.getTime());

/** 履歴の最後の進め方。いまの進め方（ADR 0016）。変えたことがなければ既定 */
const latestModeOf = (changes: ReadonlyArray<AdvanceModeChange>): AdvanceMode =>
  changes.at(-1)?.mode ?? AdvanceMode.default;

const sizeOf = (json: unknown): number => JSON.stringify(json).length;

export const Import = {
  spanOf: (session: ClosedSession): ClosedSessionSpan => ({
    kind: "Closed",
    startedAt: session.events[0].at,
    endedAt: session.endedAt,
  }),

  /**
   * 2つのセッションの時間が重なるか。両端を含める: 一方の終わった時刻ともう一方の始めた時刻が同じでも重なる。
   * 同じミリ秒にある進め方の行が、もう一方のセッションの計算に入ってしまうため
   */
  overlaps: (a: SessionSpan, b: SessionSpan): boolean =>
    a.startedAt.getTime() <= endOf(b) && b.startedAt.getTime() <= endOf(a),

  /**
   * 1つのセッションを取り込むときに、アカウントの進め方の履歴に足す行（ADR 0020、ADR 0016）。
   *
   * `existing` はいまのアカウントの履歴（時刻の順）。足す行は同じ時刻の行の後ろに並ぶ。
   *
   * 1. 始めた時刻: 端末でその時刻に効いていた進め方。アカウントでその時刻に効いているものと違うときだけ足す
   *    （sessionLoader は履歴を全部読むので、同じ値の行を積まない）
   * 2. 始めた時刻より後、終わった時刻まで（両端の後ろを含む）の端末の変更: 全部を時刻のまま足す。
   *    進め方の変更は自動終了の判断で操作として数えるので、値が変わらない変更も落とさない
   * 3. `HasOwnRecords` のときだけ、終わった時刻の 1 ミリ秒後に、アカウントのその時刻の進め方へ戻す行。
   *    1 と 2 を足したあとに効いているものと違うときだけ。終わった時刻ちょうどに置くと、閉じたセッションの
   *    計算（終わった時刻までの行を読む）に入り、自動終了したセッションの状態が端末で計算したものと変わる。
   *    1 ミリ秒後にはアカウントのセッションはない（重なりは両端を含めて判断する）
   *
   * 不変条件（`HasOwnRecords`）: セッションの範囲の外のどの時刻 t でも
   * `modeAt(existing ++ 結果, t)` と `modeAt(existing, t)` は同じ。アカウントのセッションの計算は変わらない
   */
  advanceModeRows: (
    input: Readonly<{
      session: ClosedSession;
      device: ReadonlyArray<AdvanceModeChange>;
      existing: ReadonlyArray<AdvanceModeChange>;
      account: AccountRecords;
    }>,
  ): ReadonlyArray<AdvanceModeChange> => {
    const { startedAt, endedAt } = Import.spanOf(input.session);
    const deviceAtStart = AdvanceModeChange.modeAt(input.device, startedAt);
    const startRows = AdvanceMode.equals(
      deviceAtStart,
      AdvanceModeChange.modeAt(input.existing, startedAt),
    )
      ? []
      : [{ at: startedAt, mode: deviceAtStart }];
    const during = input.device.filter(
      ({ at }) => at.getTime() > startedAt.getTime() && at.getTime() <= endedAt.getTime(),
    );
    const rows = [...startRows, ...during];
    switch (input.account.kind) {
      case "OnlyImported":
        return rows;
      case "HasOwnRecords": {
        const restoreAt = new Date(endedAt.getTime() + 1);
        const account = AdvanceModeChange.modeAt(input.existing, restoreAt);
        const effective = AdvanceModeChange.modeAt(withRows(input.existing, rows), restoreAt);
        return AdvanceMode.equals(account, effective)
          ? rows
          : [...rows, { at: restoreAt, mode: account }];
      }
    }
  },

  /**
   * 束の最後に、アカウントのいまの進め方を端末のいまの進め方にする行（ADR 0020）。`OnlyImported` のときだけ。
   * 時刻は `now` と履歴の最後の時刻の遅いほう。すでに同じなら足さないので、やり直しても増えない。0件か1件
   */
  currentModeRows: (
    input: Readonly<{
      account: AccountRecords;
      existing: ReadonlyArray<AdvanceModeChange>;
      device: ReadonlyArray<AdvanceModeChange>;
      now: Date;
    }>,
  ): ReadonlyArray<AdvanceModeChange> => {
    switch (input.account.kind) {
      case "HasOwnRecords":
        return [];
      case "OnlyImported": {
        const deviceMode = latestModeOf(input.device);
        if (AdvanceMode.equals(latestModeOf(input.existing), deviceMode)) {
          return [];
        }
        const last = input.existing.at(-1)?.at.getTime() ?? Number.NEGATIVE_INFINITY;
        return [{ at: new Date(Math.max(input.now.getTime(), last)), mode: deviceMode }];
      }
    }
  },

  /**
   * 閉じたセッションを、件数と大きさの上限で束に分ける（順は保つ）。どの束にも端末の進め方の履歴を全部持たせる。
   * 大きさは送る形（`ImportBatch.toJson`）の JSON の文字数で見積もる
   */
  batches: (
    sessions: ReadonlyArray<ClosedSession>,
    advanceModeChanges: ReadonlyArray<AdvanceModeChange>,
  ): ReadonlyArray<ImportBatch> => {
    const base = sizeOf(ImportBatch.toJson({ sessions: [], advanceModeChanges }));
    const groups: Array<{ sessions: Array<ClosedSession>; size: number }> = [];
    for (const session of sessions) {
      // 区切りのカンマの分を1文字足す
      const size = sizeOf(SessionRecord.toJson({ kind: "Closed", session })) + 1;
      const last = groups.at(-1);
      if (
        last !== undefined &&
        last.sessions.length < IMPORT_BATCH_MAX_SESSIONS &&
        last.size + size <= IMPORT_BATCH_MAX_CHARS
      ) {
        last.sessions.push(session);
        last.size += size;
      } else {
        groups.push({ sessions: [session], size: base + size });
      }
    }
    return groups.map(({ sessions: grouped }) => ({ sessions: grouped, advanceModeChanges }));
  },

  /** 取り込みのダイアログに出す数。記入は削除していないものだけを数える */
  summaryOf: (sessions: ReadonlyArray<ClosedSession>): ImportSummary => ({
    sessions: sessions.length,
    entries: sessions.reduce(
      (sum, session) => sum + session.entries.filter(({ kind }) => kind === "Written").length,
      0,
    ),
  }),
} as const;

// ---------------------------------------------------------------------------
// ワークフローが使う読み書きの契約（kamae: 概念の隣に置き、1つの契約に1つの操作）
// ---------------------------------------------------------------------------

/** ID のセッションがアカウントにあるか（開いているか、取り込んだものかを問わない） */
export type SessionExists = (id: SessionId) => boolean;

/** `span` と時間が重なるアカウントのセッション（開いているものを含む）。重なりは `Import.overlaps` で判断する */
export type FindOverlappingSession = (span: ClosedSessionSpan) => SessionId | undefined;

/** アカウントに取り込み以外の記録があるか */
export type LoadAccountRecords = () => AccountRecords;

/**
 * 閉じたセッションを、操作イベント・記入（削除した記入の印を含む）・タグ・終わり方とともに、
 * 取り込みの印をつけて記録する。タグの上限は確かめない（ADR 0020）
 */
export type SaveImportedSession = (session: ClosedSession) => void;

/** 進め方の変更を、取り込みの印をつけて記録する */
export type SaveImportedAdvanceModeChange = (change: AdvanceModeChange) => void;
