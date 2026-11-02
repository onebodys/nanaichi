import { createContext, createElement, useContext, type ReactNode } from "react";
import type { Result } from "@praha/byethrow";
import type { AdvanceMode } from "../domain/advance-mode.ts";
import type { ApiErrorCode } from "../domain/api-error.ts";
import type { DeletedJournalEntry, JournalEntry, JournalEntryId } from "../domain/journal-entry.ts";
import type { EntriesOnDate, JournalCalendar, JournalMonth } from "../domain/journal-calendar.ts";
import type { LocalDate } from "../domain/local-date.ts";
import type { SessionEventId, SessionOperation } from "../domain/session-event.ts";
import type { SessionSnapshot } from "../domain/session.ts";
import type { StatsPeriod, StatsReport } from "../domain/stats.ts";
import type { DeletedTag, TagDeletion, TagList, TagName, TagUsageList } from "../domain/tag.ts";
import type { TaggedEntriesPage } from "../domain/tagged-entries.ts";
import type { TimelinePage } from "../domain/timeline.ts";
import type { SyncConnection, SyncHandlers } from "./sync-connection.ts";

/**
 * 画面（hooks）が記録を読み書きする入口。どこに記録があるか（アカウントのサーバーか、この端末か）は
 * `Backend` の向こう側の事情で、画面は知らない。HTTP のステータスや保存先の都合も見せない。
 */

export type BackendError =
  /** いま記録に届かない（オフラインなど）。やり直せば通りうる */
  | Readonly<{ kind: "Unreachable" }>
  /** 想定内の失敗。`code` で扱いを決める */
  | Readonly<{ kind: "Rejected"; code: ApiErrorCode }>
  /** この端末への保存に失敗した（端末に記録を置く場合だけ） */
  | Readonly<{ kind: "StorageFailed"; reason: "QuotaExceeded" | "Unavailable" | "NewerFormat" }>
  /** 応答や保存した記録が、読めない形だった。アプリと記録の食い違いか障害 */
  | Readonly<{ kind: "Broken" }>;

type Call<T> = Result.ResultAsync<T, BackendError>;

/**
 * ページごとに1つ。ページを開いている間、`Backend` は入れ替わらない
 * （ログインとログアウトはページ全体の移動なので、画面の状態を作り直す必要がない）。
 */
export type Backend = Readonly<{
  /** 現在のセッションのスナップショット */
  getCurrentSession: () => Call<SessionSnapshot>;
  /**
   * セッションを開始する。`id` は開始の操作イベントの ID（ADR 0007）。
   * やり直すときは同じ ID で送れば、二重に開始しない。
   */
  startSession: (id: SessionEventId) => Call<SessionSnapshot>;
  /** セッションに操作を1つ加える。`id` は操作イベントの ID */
  operateSession: (id: SessionEventId, kind: SessionOperation["kind"]) => Call<SessionSnapshot>;
  /**
   * ジャーナル記入を書く。`id` は記入の ID（ADR 0010）。
   * やり直すときは同じ ID で送れば、二重に書かない。本文は送るときだけ取り出す
   */
  writeJournalEntry: (
    id: JournalEntryId,
    body: string,
    tags: ReadonlyArray<TagName>,
  ) => Call<JournalEntry>;
  /** 記入の本文とタグを書き直す */
  editJournalEntry: (
    id: JournalEntryId,
    body: string,
    tags: ReadonlyArray<TagName>,
  ) => Call<JournalEntry>;
  /** 記入を削除する */
  deleteJournalEntry: (id: JournalEntryId) => Call<DeletedJournalEntry>;
  /** タイムラインの1ページ。`before` を省けば最新のページ */
  getTimeline: (before?: Date) => Call<TimelinePage>;
  /** 入力の候補に出す、使っているタグ（最近使った順） */
  getTags: () => Call<TagList>;
  /** 設定画面に出す、使っているタグとその記入の数（最近使った順） */
  getTagUsage: () => Call<TagUsageList>;
  /**
   * タグを削除する。ついている記入からは外すか、`deletion` の付け替え先に付け替える（ADR 0017）
   */
  deleteTag: (name: TagName, deletion: TagDeletion) => Call<DeletedTag>;
  /** 期間のスタッツ（ADR 0014）。`timeZone` は端末のタイムゾーンで、日付と時間帯はこれで区切る */
  getStats: (period: StatsPeriod, timeZone: string) => Call<StatsReport>;
  /** ジャーナルのカレンダーの1か月分。記入は `timeZone` で区切った日付に数える */
  getJournalCalendar: (month: JournalMonth, timeZone: string) => Call<JournalCalendar>;
  /** `timeZone` で区切った日付 `date` に書いた記入 */
  getEntriesOnDate: (date: LocalDate, timeZone: string) => Call<EntriesOnDate>;
  /** タグのついた記入の1ページ（新しい順）。`before` を省けば最新のページ */
  getEntriesWithTag: (tag: TagName, before?: Date) => Call<TaggedEntriesPage>;
  /** いまのフェーズの進め方（ADR 0016） */
  getAdvanceMode: () => Call<AdvanceMode>;
  /** フェーズの進め方を変える。変えたあとの進め方が返る */
  changeAdvanceMode: (mode: AdvanceMode) => Call<AdvanceMode>;
  /** 同期メッセージ（ADR 0012）を受け取り始める。`close` で止める */
  subscribe: (handlers: SyncHandlers) => SyncConnection;
}>;

const BackendContext = createContext<Backend | undefined>(undefined);

export const BackendProvider = ({
  backend,
  children,
}: Readonly<{ backend: Backend; children: ReactNode }>): ReactNode =>
  createElement(BackendContext.Provider, { value: backend }, children);

/** `BackendProvider` の外で使うのは実装の誤りなので、例外にする */
export const useBackend = (): Backend => {
  const backend = useContext(BackendContext);
  if (backend === undefined) {
    throw new Error("useBackend は BackendProvider の中で使う");
  }
  return backend;
};
