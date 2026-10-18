import * as v from "valibot";
import { JsonDateSchema } from "./json-date.ts";

/**
 * 操作イベント（GLOSSARY の「操作イベント」）。
 *
 * 人がセッションに対して行った操作だけを、行った時刻とともに記録する。
 * 時間が過ぎたことによるフェーズの切り替わりは記録せず、`deriveTimerState` が時刻から計算する（ADR 0003）。
 */
type Start = Readonly<{ kind: "Start"; at: Date }>;
type Pause = Readonly<{ kind: "Pause"; at: Date }>;
type Resume = Readonly<{ kind: "Resume"; at: Date }>;
type Abort = Readonly<{ kind: "Abort"; at: Date }>;
type RestartFocus = Readonly<{ kind: "RestartFocus"; at: Date }>;
type SkipBreak = Readonly<{ kind: "SkipBreak"; at: Date }>;
/** 切り替え待ちから次のフェーズを始める（ADR 0015） */
type Advance = Readonly<{ kind: "Advance"; at: Date }>;
type End = Readonly<{ kind: "End"; at: Date }>;

/** 開始の後にセッションへ行える操作 */
export type SessionOperation = Pause | Resume | Abort | RestartFocus | SkipBreak | Advance | End;

/**
 * 1つのセッションの操作イベントを時刻の順に並べたもの。
 *
 * セッションは必ず開始から始まり、開始はセッションに1回だけなので、先頭だけを開始にする型で表す。
 */
export type SessionEvents = readonly [Start, ...ReadonlyArray<SessionOperation>];

const SESSION_OPERATION_KINDS = [
  "Pause",
  "Resume",
  "Abort",
  "RestartFocus",
  "SkipBreak",
  "Advance",
  "End",
] as const satisfies ReadonlyArray<SessionOperation["kind"]>;

/**
 * 操作イベントの ID。クライアントが発行する（ADR 0007）。
 *
 * 同じ ID の操作が2回届いても1回分しか記録しないことで、通信のやり直しによる二重送信を防ぐ。
 * 将来オフラインで記録したイベントを後から同期するときも、この ID で重複を見分ける。
 */
const SessionEventIdSchema = v.pipe(v.string(), v.uuid(), v.brand("SessionEventId"));
export type SessionEventId = v.InferOutput<typeof SessionEventIdSchema>;

export const SessionEventId = {
  schema: SessionEventIdSchema,
} as const;

/** 記録済みの操作イベント。記録するときに ID が付く */
export type RecordedSessionEvent<E extends Start | SessionOperation = Start | SessionOperation> =
  E & Readonly<{ id: SessionEventId }>;

/** 記録済みの操作イベントを時刻の順に並べたもの。`SessionEvents` としてそのまま計算に使える */
export type RecordedSessionEvents = readonly [
  RecordedSessionEvent<Start>,
  ...ReadonlyArray<RecordedSessionEvent<SessionOperation>>,
];

export const SessionOperationKind = {
  schema: v.picklist(SESSION_OPERATION_KINDS),
} as const;

/** JSON にした記録済みの操作イベントの並び（API の応答）を検証して戻す（AGENTS.md §5） */
export const RecordedSessionEventsJsonSchema: v.GenericSchema<unknown, RecordedSessionEvents> =
  v.tupleWithRest(
    [v.object({ kind: v.literal("Start"), id: SessionEventIdSchema, at: JsonDateSchema })],
    v.object({
      kind: SessionOperationKind.schema,
      id: SessionEventIdSchema,
      at: JsonDateSchema,
    }),
  );
