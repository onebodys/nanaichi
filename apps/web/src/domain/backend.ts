import type { Result } from "@praha/byethrow";
import type { AdvanceMode } from "./advance-mode.ts";
import type { ApiErrorCode } from "./api-error.ts";
import type { DeletedJournalEntry, JournalEntry, JournalEntryId } from "./journal-entry.ts";
import type { EntriesOnDate, JournalCalendar, JournalMonth } from "./journal-calendar.ts";
import type { LocalDate } from "./local-date.ts";
import type { SessionEventId, SessionOperation } from "./session-event.ts";
import type { SessionSnapshot } from "./session.ts";
import type { StatsPeriod, StatsReport } from "./stats.ts";
import type { DeletedTag, TagDeletion, TagList, TagName, TagUsageList } from "./tag.ts";
import type { TaggedEntriesPage } from "./tagged-entries.ts";
import type { TimelinePage } from "./timeline.ts";
import type { SyncMessage } from "./sync-message.ts";

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

export type Backend = Readonly<{
  getCurrentSession: () => Call<SessionSnapshot>;
  /**
   * セッションを開始する。`id` は開始の操作イベントの ID（ADR 0007）。
   * やり直すときは同じ ID で送れば、二重に開始しない。
   */
  startSession: (id: SessionEventId) => Call<SessionSnapshot>;
  operateSession: (id: SessionEventId, kind: SessionOperation["kind"]) => Call<SessionSnapshot>;
  /**
   * ジャーナル記入を書く。`id` は記入の ID（ADR 0010）。
   * やり直すときは同じ ID で送れば、二重に書かない。
   */
  writeJournalEntry: (
    id: JournalEntryId,
    body: string,
    tags: ReadonlyArray<TagName>,
  ) => Call<JournalEntry>;
  editJournalEntry: (
    id: JournalEntryId,
    body: string,
    tags: ReadonlyArray<TagName>,
  ) => Call<JournalEntry>;
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
  getAdvanceMode: () => Call<AdvanceMode>;
  /** フェーズの進め方を変える。変えたあとの進め方が返る */
  changeAdvanceMode: (mode: AdvanceMode) => Call<AdvanceMode>;
  /** 同期メッセージ（ADR 0012）を受け取り始める。`close` で止める */
  subscribe: (handlers: SyncHandlers) => SyncConnection;
}>;

export type SyncHandlers = Readonly<{
  onConnected: () => void;
  onMessage: (message: SyncMessage) => void;
}>;

export type SyncConnection = Readonly<{
  /**
   * 今すぐ繋がっているかを確かめる。画面に戻ってきたときやオンラインに戻ったときに呼ぶ。
   * 繋ぎ直しを待っている間なら待たずに繋ぎ直し、繋がっているなら `ping` で確かめる
   */
  check: () => void;
  /** 接続を閉じ、繋ぎ直しもやめる */
  close: () => void;
}>;
