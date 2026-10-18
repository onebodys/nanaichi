import * as v from "valibot";
import { AdvanceModeJsonSchema, type AdvanceMode } from "./advance-mode.ts";
import {
  DeletedJournalEntryJsonSchema,
  JournalEntry,
  JournalEntryJsonSchema,
  type DeletedJournalEntry,
  type JournalEntryJson,
} from "./journal-entry.ts";
import { SessionSnapshotJsonSchema, type SessionSnapshot } from "./session.ts";

/**
 * 同期メッセージ（GLOSSARY の「同期メッセージ」）。UserDO が記録を変えるたびに、
 * そのユーザーのすべての接続へ WebSocket で送る（ADR 0012）。
 *
 * - `SessionChanged`: セッションが変わった（開始・操作・記入で自動終了の時刻が延びた）。新しいスナップショット
 * - `JournalEntrySaved`: 記入を書いた・編集した
 * - `JournalEntryDeleted`: 記入を削除した
 * - `AdvanceModeChanged`: フェーズの進め方を変えた（ADR 0016）。進行中のセッションがあれば、
 *   あわせて `SessionChanged` も送る
 */
export type SyncMessage =
  | Readonly<{ kind: "SessionChanged"; snapshot: SessionSnapshot }>
  | Readonly<{ kind: "JournalEntrySaved"; entry: JournalEntry }>
  | Readonly<{ kind: "JournalEntryDeleted"; deleted: DeletedJournalEntry }>
  | Readonly<{ kind: "AdvanceModeChanged"; mode: AdvanceMode }>;

/** JSON にした同期メッセージ。記入の本文を取り出してある（ADR 0010） */
type SyncMessageJson =
  | Readonly<{ kind: "SessionChanged"; snapshot: SessionSnapshot }>
  | Readonly<{ kind: "JournalEntrySaved"; entry: JournalEntryJson }>
  | Readonly<{ kind: "JournalEntryDeleted"; deleted: DeletedJournalEntry }>
  | Readonly<{ kind: "AdvanceModeChanged"; mode: AdvanceMode }>;

/**
 * JSON にした同期メッセージ（WebSocket で届いた文字列を `JSON.parse` したもの）を検証して戻す。
 * 記入の本文は `Sensitive` に包み直す（AGENTS.md §5）。
 */
export const SyncMessageJsonSchema: v.GenericSchema<unknown, SyncMessage> = v.variant("kind", [
  v.object({ kind: v.literal("SessionChanged"), snapshot: SessionSnapshotJsonSchema }),
  v.object({ kind: v.literal("JournalEntrySaved"), entry: JournalEntryJsonSchema }),
  v.object({ kind: v.literal("JournalEntryDeleted"), deleted: DeletedJournalEntryJsonSchema }),
  v.object({ kind: v.literal("AdvanceModeChanged"), mode: AdvanceModeJsonSchema }),
]);

export const SyncMessage = {
  /** 送る文字列にする。記入の本文は送るときだけ取り出す（`Sensitive` は JSON にすると伏せ字になる） */
  serialize: (message: SyncMessage): string => {
    switch (message.kind) {
      case "JournalEntrySaved":
        return JSON.stringify({
          kind: message.kind,
          entry: JournalEntry.toJson(message.entry),
        } satisfies SyncMessageJson);
      case "SessionChanged":
      case "JournalEntryDeleted":
      case "AdvanceModeChanged":
        return JSON.stringify(message satisfies SyncMessageJson);
    }
  },
} as const;
