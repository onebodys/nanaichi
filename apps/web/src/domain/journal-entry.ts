import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { JsonDateSchema } from "./json-date.ts";
import { Sensitive } from "./sensitive.ts";
import { SessionId } from "./session.ts";
import { DeletedTag, Tags, type TagName } from "./tag.ts";
import type { TimerState } from "./timer-state.ts";

/**
 * ジャーナル記入の ID。クライアントが発行する（ADR 0010）。
 *
 * 同じ ID の記入が2回届いても1件しか記録しないことで、通信のやり直しによる二重送信を防ぐ。
 */
const JournalEntryIdSchema = v.pipe(v.string(), v.uuid(), v.brand("JournalEntryId"));
export type JournalEntryId = v.InferOutput<typeof JournalEntryIdSchema>;

export const JournalEntryId = {
  schema: JournalEntryIdSchema,
} as const;

/** 1件の記入の長さの上限。1分のジャーナルで書く量には十分で、誤って巨大な本文を送るのを防ぐ */
const BODY_MAX_LENGTH = 10_000;

/**
 * ジャーナル記入の本文。プレーンテキスト（改行可）で、前後の空白は落とす。空の記入は書けない。
 *
 * 本文は PII なので、検証するとその場で `Sensitive` に包む（AGENTS.md「境界での検証と PII」）。
 */
const JournalEntryBodySchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(BODY_MAX_LENGTH),
  v.transform(Sensitive.of),
);
export type JournalEntryBody = v.InferOutput<typeof JournalEntryBodySchema>;

export const JournalEntryBody = {
  schema: JournalEntryBodySchema,
} as const;

/**
 * 書いた時点のタイマーの状態のうち、記入に紐付けるもの（GLOSSARY の「ジャーナル記入」）。
 *
 * - 集中・ジャーナル: ラウンドとセットとフェーズに紐付く
 * - 休憩: どのセットにも属さないので、ラウンドとフェーズだけ
 * - 待機: どのフェーズにもないので、ラウンドと次にやり直すセットだけ
 * - 切り替え待ち: 時間が過ぎて終わったフェーズとして紐付ける（専用の種類は持たない）
 */
export type WrittenDuring =
  | Readonly<{ kind: "Focus"; round: number; setNumber: number }>
  | Readonly<{ kind: "Journal"; round: number; setNumber: number }>
  | Readonly<{ kind: "Break"; round: number }>
  | Readonly<{ kind: "Idle"; round: number; setNumber: number }>;

/**
 * ジャーナル記入（GLOSSARY の「ジャーナル記入」）。
 *
 * - `tags`: つけたタグ（GLOSSARY の「タグ」）。つけた順で、つけていなければ空
 * - `writtenAt`: 書いた時刻。編集しても変わらない
 * - `updatedAt`: 最後に書いた・編集した時刻
 */
export type JournalEntry = Readonly<{
  id: JournalEntryId;
  sessionId: SessionId;
  body: JournalEntryBody;
  tags: ReadonlyArray<TagName>;
  writtenAt: Date;
  updatedAt: Date;
  writtenDuring: WrittenDuring;
}>;

/** 削除した記入。削除は論理削除で、タイムラインには出ない（ADR 0010） */
export type DeletedJournalEntry = Readonly<{ id: JournalEntryId; deletedAt: Date }>;

/** 記録されている記入。削除したものも ID の重複を見分けるために残っている */
export type StoredJournalEntry =
  | Readonly<{ kind: "Written"; entry: JournalEntry }>
  | Readonly<{ kind: "Deleted"; deleted: DeletedJournalEntry }>;

/** セッションの外（終了したあとを含む）では書けない */
export type NoSessionInProgress = Readonly<{ kind: "NoSessionInProgress" }>;

/**
 * JSON にした記入。`Sensitive` は JSON にすると伏せ字になるので、応答では本文を取り出しておく（ADR 0010）。
 * 時刻は `Date` のままでよい（`c.json` が ISO 8601 の文字列にする）。
 */
export type JournalEntryJson = Omit<JournalEntry, "body"> & Readonly<{ body: string }>;

const positiveInt = v.pipe(v.number(), v.integer(), v.minValue(1));

const WrittenDuringJsonSchema = v.variant("kind", [
  v.object({ kind: v.literal("Focus"), round: positiveInt, setNumber: positiveInt }),
  v.object({ kind: v.literal("Journal"), round: positiveInt, setNumber: positiveInt }),
  v.object({ kind: v.literal("Break"), round: positiveInt }),
  v.object({ kind: v.literal("Idle"), round: positiveInt, setNumber: positiveInt }),
]);

/** JSON にした記入（`POST /api/journal-entries` などの応答）を検証して戻す。本文は `Sensitive` に包み直す */
export const JournalEntryJsonSchema: v.GenericSchema<unknown, JournalEntry> = v.object({
  id: JournalEntryIdSchema,
  sessionId: SessionId.schema,
  body: JournalEntryBodySchema,
  tags: Tags.schema,
  writtenAt: JsonDateSchema,
  updatedAt: JsonDateSchema,
  writtenDuring: WrittenDuringJsonSchema,
});

/** JSON にした削除済みの記入（`DELETE /api/journal-entries/:id` の応答）を検証して戻す */
export const DeletedJournalEntryJsonSchema: v.GenericSchema<unknown, DeletedJournalEntry> =
  v.object({ id: JournalEntryIdSchema, deletedAt: JsonDateSchema });

/** 時刻 `now` のタイマーの状態から、記入に紐付けるものを決める。終了していれば書けない */
const writtenDuringOf = (state: TimerState): Result.Result<WrittenDuring, NoSessionInProgress> => {
  switch (state.kind) {
    case "Focus":
    case "Journal":
    case "Idle":
      return Result.succeed({ kind: state.kind, round: state.round, setNumber: state.setNumber });
    case "Break":
      return Result.succeed({ kind: state.kind, round: state.round });
    case "AwaitingAdvance":
      // 切り替え待ちの間に書いたものは、時間が過ぎて終わったフェーズに紐付く（GLOSSARY）
      return Result.succeed(state.finished);
    case "Ended":
      return Result.fail({ kind: "NoSessionInProgress" });
  }
};

export const JournalEntry = {
  /**
   * 記入を書く。書いた時点のセッションの状態に紐付ける。
   *
   * `state` は書いた時刻 `now` のタイマーの状態。終了していれば（自動終了を含む）セッションの外なので書けない。
   */
  write: (
    input: Readonly<{
      id: JournalEntryId;
      body: JournalEntryBody;
      tags: ReadonlyArray<TagName>;
      sessionId: SessionId;
      state: TimerState;
      now: Date;
    }>,
  ): Result.Result<JournalEntry, NoSessionInProgress> =>
    Result.pipe(
      writtenDuringOf(input.state),
      Result.map((writtenDuring): JournalEntry => ({
        id: input.id,
        sessionId: input.sessionId,
        body: input.body,
        tags: input.tags,
        writtenAt: input.now,
        updatedAt: input.now,
        writtenDuring,
      })),
    ),

  /** 本文とタグを書き直す。書いた時刻と紐付きは変えない（ADR 0010） */
  edit: (
    entry: JournalEntry,
    change: Readonly<{ body: JournalEntryBody; tags: ReadonlyArray<TagName> }>,
    now: Date,
  ): JournalEntry => ({
    ...entry,
    body: change.body,
    tags: change.tags,
    updatedAt: now,
  }),

  /**
   * 削除したタグを記入から外す（付け替えるなら付け替え先に置き換える）。記入を編集するのではないので、
   * 更新時刻は変えない（GLOSSARY の「タグの削除」、ADR 0017）
   */
  deleteTag: (entry: JournalEntry, deleted: DeletedTag): JournalEntry => ({
    ...entry,
    tags: DeletedTag.applyTo(entry.tags, deleted),
  }),

  /** 応答に使う JSON にできる形。本文は応答の中でだけ取り出す */
  toJson: (entry: JournalEntry): JournalEntryJson => ({ ...entry, body: entry.body.unwrap() }),
} as const;

// ---------------------------------------------------------------------------
// ワークフローが使う読み書きの契約（kamae: 概念の隣に置き、1つの契約に1つの操作）
// ---------------------------------------------------------------------------

/** ID から記録されている記入を探す。削除したものも見つかる（ID の重複を見分けるため） */
export type FindJournalEntry = (id: JournalEntryId) => StoredJournalEntry | undefined;

/** 書いたばかりの記入を記録する */
export type SaveJournalEntry = (entry: JournalEntry) => void;

/** 編集した記入の本文・タグと更新時刻を記録する */
export type SaveEditedJournalEntry = (entry: JournalEntry) => void;

/** 記入を論理削除する */
export type DeleteJournalEntry = (deleted: DeletedJournalEntry) => void;

/**
 * `id` 以外の削除していない記入についているタグ。記入にタグをつけたときに、使っているタグの種類が
 * 上限を超えないかを確かめるのに使う（`Tag.ensureWithinLimit`）。書き直す記入自身のタグは数えない
 */
export type ListTagsOfOtherEntries = (id: JournalEntryId) => ReadonlyArray<TagName>;

/** タグ `name` がついている、削除していない記入を読む */
export type ListJournalEntriesTaggedWith = (name: TagName) => ReadonlyArray<JournalEntry>;

/** 記入のタグだけを記録し直す（本文と更新時刻は変えない） */
export type SaveJournalEntryTags = (entry: JournalEntry) => void;
