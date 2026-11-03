import { DurableObject } from "cloudflare:workers";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import type { AdvanceMode } from "../domain/advance-mode.ts";
import type { ImportReceipt } from "../domain/import.ts";
import {
  JournalEntry,
  type DeletedJournalEntry,
  type JournalEntryJson,
} from "../domain/journal-entry.ts";
import { JournalPeriod, type JournalPeriodReportJson } from "../domain/journal-period.ts";
import {
  JournalCalendar,
  type EntriesOnDateJson,
  type JournalCalendar as JournalCalendarReport,
} from "../domain/journal-calendar.ts";
import { SessionId, type SessionSnapshot } from "../domain/session.ts";
import { SyncMessage } from "../domain/sync-message.ts";
import type { StatsReport } from "../domain/stats.ts";
import type { DeletedTag, TagList, TagUsageList } from "../domain/tag.ts";
import { TaggedEntries, type TaggedEntriesPageJson } from "../domain/tagged-entries.ts";
import { Timeline, type TimelinePageJson } from "../domain/timeline.ts";
import { settleAutoEnd, type AutoEndSchedule } from "../workflows/auto-end-session.ts";
import type { ChangeAdvanceModeError } from "../workflows/change-advance-mode.ts";
import type { DeleteJournalEntryError } from "../workflows/delete-journal-entry.ts";
import type { DeleteTagError } from "../workflows/delete-tag.ts";
import type { EditJournalEntryError } from "../workflows/edit-journal-entry.ts";
import { getAdvanceMode } from "../workflows/get-advance-mode.ts";
import { getCurrentSession } from "../workflows/get-current-session.ts";
import { getJournalPeriod, type GetJournalPeriodError } from "../workflows/get-journal-period.ts";
import { getEntriesOnDate, type GetEntriesOnDateError } from "../workflows/get-entries-on-date.ts";
import {
  getEntriesWithTag,
  type GetEntriesWithTagError,
} from "../workflows/get-entries-with-tag.ts";
import {
  getJournalCalendar,
  type GetJournalCalendarError,
} from "../workflows/get-journal-calendar.ts";
import { getStats, type GetStatsError } from "../workflows/get-stats.ts";
import { getTagUsage } from "../workflows/get-tag-usage.ts";
import { getTags } from "../workflows/get-tags.ts";
import { getTimeline, type GetTimelineError } from "../workflows/get-timeline.ts";
import type { ImportSessionsError } from "../workflows/import-sessions.ts";
import type { OperateSessionError } from "../workflows/operate-session.ts";
import type { StartSessionError } from "../workflows/start-session.ts";
import {
  changeAdvanceModeCommand,
  deleteJournalEntryCommand,
  deleteTagCommand,
  editJournalEntryCommand,
  importSessionsCommand,
  operateSessionCommand,
  startSessionCommand,
  writeJournalEntryCommand,
  type Executed,
} from "../workflows/user-commands.ts";
import type { WriteJournalEntryError } from "../workflows/write-journal-entry.ts";
import { importSqlite } from "./import-sqlite.ts";
import { journalSqlite, type JournalSqlite } from "./journal-sqlite.ts";
import { sessionSqlite, type SessionSqlite } from "./session-sqlite.ts";
import { statsSqlite } from "./stats-sqlite.ts";
import { migrate } from "./user-do-schema.ts";

// `crypto.randomUUID()` は必ず UUID を返すので、検証に失敗するのは実装の誤り（例外でよい）
const newSessionId = (): SessionId => v.parse(SessionId.schema, crypto.randomUUID());

/**
 * ユーザーごとの Durable Object（ADR 0002）。セッション・操作イベント・ジャーナル記入を持つ。
 *
 * Imperative Shell として、時刻と ID を作り、ワークフローに SQLite の読み書きを渡し、
 * alarm を張り、記録を変えたら同期メッセージを全接続へ送るだけにする。判断はすべてワークフローとドメインにある。
 *
 * 同期の WebSocket は Hibernation API で受け入れる（ADR 0012）。画面からの `ping` にはランタイムが
 * `pong` を返すので、接続があっても UserDO は休止できる。
 *
 * Durable Object はランタイムの都合でクラス継承が必須（kamae の「クラスを使わない」からの例外）。
 */
export class UserDO extends DurableObject<Env> {
  readonly #sessions: SessionSqlite;
  readonly #journal: JournalSqlite;
  readonly #stats: ReturnType<typeof statsSqlite>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // SQLite の API は同期なので、最初のリクエストより前に必ず終わる
    migrate(ctx.storage.sql, new Date());
    this.#sessions = sessionSqlite(ctx.storage.sql);
    this.#journal = journalSqlite(ctx.storage.sql);
    this.#stats = statsSqlite(ctx.storage.sql);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /**
   * `GET /api/ws`。ログインと Upgrade・Origin の確認は Worker 側のルートが済ませている（sync-routes.ts）。
   * 画面からのメッセージ（`ping` 以外）は使わないので、`webSocketMessage` は定義しない。
   */
  override async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** `GET /api/session/current` */
  async getCurrentSession(): Promise<SessionSnapshot> {
    return this.#run((now) => getCurrentSession(this.#sessions)(now));
  }

  /** `POST /api/session`。`raw` はリクエストの本文で、検証はワークフローが行う */
  async startSession(raw: unknown): Promise<Result.Result<SessionSnapshot, StartSessionError>> {
    return this.#execute((now) => startSessionCommand(this.#sessions)(raw, now, newSessionId()));
  }

  /** `POST /api/session/commands`。`raw` はリクエストの本文で、検証はワークフローが行う */
  async operateSession(raw: unknown): Promise<Result.Result<SessionSnapshot, OperateSessionError>> {
    return this.#execute((now) => operateSessionCommand(this.#sessions)(raw, now));
  }

  // 記入の本文は `Sensitive` に包まれていて RPC で送れない（関数を含む）ため、
  // DO の中で応答の JSON にできる形（`toJson`）にしてから返す（ADR 0010）

  /** `POST /api/journal-entries`。`raw` はリクエストの本文で、検証はワークフローが行う */
  async writeJournalEntry(
    raw: unknown,
  ): Promise<Result.Result<JournalEntryJson, WriteJournalEntryError>> {
    const result = await this.#execute((now) =>
      writeJournalEntryCommand({ ...this.#sessions, ...this.#journal })(raw, now),
    );
    return Result.pipe(result, Result.map(JournalEntry.toJson));
  }

  /** `PATCH /api/journal-entries/:id` */
  async editJournalEntry(
    rawId: unknown,
    raw: unknown,
  ): Promise<Result.Result<JournalEntryJson, EditJournalEntryError>> {
    const result = await this.#execute((now) =>
      editJournalEntryCommand(this.#journal)(rawId, raw, now),
    );
    return Result.pipe(result, Result.map(JournalEntry.toJson));
  }

  /** `DELETE /api/journal-entries/:id` */
  async deleteJournalEntry(
    rawId: unknown,
  ): Promise<Result.Result<DeletedJournalEntry, DeleteJournalEntryError>> {
    return this.#execute((now) => deleteJournalEntryCommand(this.#journal)(rawId, now));
  }

  /** `GET /api/timeline?before=`。`rawQuery` はクエリの値で、検証はワークフローが行う */
  async getTimeline(rawQuery: unknown): Promise<Result.Result<TimelinePageJson, GetTimelineError>> {
    return this.#run((now) =>
      Result.pipe(
        getTimeline({ ...this.#sessions, ...this.#journal })(rawQuery, now),
        Result.map(Timeline.toJson),
      ),
    );
  }

  /** MCP の `get_journal_entries`。`rawQuery` はツールの引数で、検証はワークフローが行う */
  async getJournalPeriod(
    rawQuery: unknown,
  ): Promise<Result.Result<JournalPeriodReportJson, GetJournalPeriodError>> {
    return this.#run(() =>
      Result.pipe(getJournalPeriod(this.#journal)(rawQuery), Result.map(JournalPeriod.toJson)),
    );
  }

  /** `GET /api/tags`。入力の候補に出す、使っているタグ */
  async getTags(): Promise<Result.Result<TagList, never>> {
    return this.#run(() => getTags(this.#journal)());
  }

  /** `GET /api/tags/usage`。設定画面のタグの一覧に出す、使っているタグとその記入の数 */
  async getTagUsage(): Promise<Result.Result<TagUsageList, never>> {
    return this.#run(() => getTagUsage(this.#journal)());
  }

  /**
   * `DELETE /api/tags/:name`。`raw` はリクエストの本文（外すか付け替えるか）で、検証はワークフローが行う。
   * 削除したら、削除したタグと付け替え先を全接続へ送る。書き換えた記入は送らない（ADR 0017）
   */
  async deleteTag(
    rawName: unknown,
    raw: unknown,
  ): Promise<Result.Result<DeletedTag, DeleteTagError>> {
    return this.#execute(() => deleteTagCommand(this.#journal)(rawName, raw));
  }

  /** `GET /api/stats?period=&timeZone=`。`rawQuery` はクエリの値で、検証はワークフローが行う */
  async getStats(rawQuery: unknown): Promise<Result.Result<StatsReport, GetStatsError>> {
    return this.#run((now) => getStats({ ...this.#sessions, ...this.#stats })(rawQuery, now));
  }

  /** `GET /api/journal-calendar?month=&timeZone=`。ジャーナルのカレンダーの1か月分 */
  async getJournalCalendar(
    rawQuery: unknown,
  ): Promise<Result.Result<JournalCalendarReport, GetJournalCalendarError>> {
    return this.#run((now) => getJournalCalendar(this.#journal)(rawQuery, now));
  }

  /** `GET /api/journal-entries/by-date?date=&timeZone=`。選んだ日の記入 */
  async getEntriesOnDate(
    rawQuery: unknown,
  ): Promise<Result.Result<EntriesOnDateJson, GetEntriesOnDateError>> {
    return this.#run(() =>
      Result.pipe(
        getEntriesOnDate(this.#journal)(rawQuery),
        Result.map(JournalCalendar.entriesOnDateToJson),
      ),
    );
  }

  /** `GET /api/journal-entries/by-tag?tag=&before=`。タグのついた記入の1ページ */
  async getEntriesWithTag(
    rawQuery: unknown,
  ): Promise<Result.Result<TaggedEntriesPageJson, GetEntriesWithTagError>> {
    return this.#run(() =>
      Result.pipe(getEntriesWithTag(this.#journal)(rawQuery), Result.map(TaggedEntries.toJson)),
    );
  }

  /** `GET /api/settings/advance-mode` */
  async getAdvanceMode(): Promise<Result.Result<AdvanceMode, never>> {
    return this.#run((now) => getAdvanceMode(this.#sessions)(now));
  }

  /**
   * `PUT /api/settings/advance-mode`。`raw` はリクエストの本文で、検証はワークフローが行う。
   * 変えたら、新しい進め方と、進行中のセッションがあればその新しいスナップショットを全接続へ送る（ADR 0016）
   */
  async changeAdvanceMode(
    raw: unknown,
  ): Promise<Result.Result<AdvanceMode, ChangeAdvanceModeError>> {
    return this.#execute((now) => changeAdvanceModeCommand(this.#sessions)(raw, now));
  }

  /**
   * `POST /api/imports`（ADR 0020）。`raw` はリクエストの本文（取り込みの束）で、検証はワークフローが行う。
   * 束全体を1つのトランザクションで書く。応答はセッションの ID と結果だけなので、本文を含まずに RPC で返せる
   */
  async importSessions(raw: unknown): Promise<Result.Result<ImportReceipt, ImportSessionsError>> {
    return this.#execute((now) =>
      importSessionsCommand({
        ...importSqlite(this.ctx.storage.sql, this.#journal),
        loadAdvanceModeChanges: this.#sessions.loadAdvanceModeChanges,
      })(raw, now),
    );
  }

  /**
   * 自動終了の時刻に鳴る。自動終了を記録し、まだなら張り直す（`#run` が行う）。
   *
   * 同期メッセージは送らない。自動終了はどの画面も時刻から計算しているので知らせることがなく、
   * 送ると「自動終了しました」の表示が「セッションなし」に置き換わってしまう（ADR 0012）。
   */
  override async alarm(): Promise<void> {
    await this.#run(() => undefined);
  }

  /**
   * ワークフローを1つのトランザクションで実行し、そのあと自動終了の alarm を張り直す。
   *
   * 途中で例外が出れば書き込みはすべて取り消される。
   */
  async #run<T>(workflow: (now: Date) => T): Promise<T> {
    const now = new Date();
    const { result, schedule } = this.ctx.storage.transactionSync(() => ({
      result: workflow(now),
      schedule: settleAutoEnd(this.#sessions)(now),
    }));
    await this.#applySchedule(schedule);
    return result;
  }

  async #execute<T, E>(
    command: (now: Date) => Result.Result<Executed<T>, E>,
  ): Promise<Result.Result<T, E>> {
    const result = await this.#run(command);
    return Result.pipe(
      result,
      Result.inspect(({ messages }) => this.#broadcast(messages)),
      Result.map(({ value }) => value),
    );
  }

  /** 同期メッセージを、このユーザーのすべての接続へ送る（ADR 0012） */
  #broadcast(messages: ReadonlyArray<SyncMessage>): void {
    const sent = messages.map(SyncMessage.serialize);
    for (const ws of this.ctx.getWebSockets()) {
      for (const message of sent) {
        // 閉じかけの接続には送れず例外になる。その画面は繋ぎ直して読み込み直すので、捨ててよい
        try {
          ws.send(message);
        } catch {
          break;
        }
      }
    }
  }

  async #applySchedule(schedule: AutoEndSchedule): Promise<void> {
    switch (schedule.kind) {
      case "Scheduled":
        return this.ctx.storage.setAlarm(schedule.at);
      case "NotScheduled":
        return this.ctx.storage.deleteAlarm();
    }
  }
}
