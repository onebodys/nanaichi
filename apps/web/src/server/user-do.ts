import { DurableObject } from "cloudflare:workers";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import {
  JournalEntry,
  type DeletedJournalEntry,
  type JournalEntryJson,
} from "../domain/journal-entry.ts";
import { SessionId, type SessionSnapshot } from "../domain/session.ts";
import { Timeline, type TimelinePageJson } from "../domain/timeline.ts";
import { settleAutoEnd, type AutoEndSchedule } from "../workflows/auto-end-session.ts";
import {
  deleteJournalEntry,
  type DeleteJournalEntryError,
} from "../workflows/delete-journal-entry.ts";
import { editJournalEntry, type EditJournalEntryError } from "../workflows/edit-journal-entry.ts";
import { getCurrentSession } from "../workflows/get-current-session.ts";
import { getTimeline, type GetTimelineError } from "../workflows/get-timeline.ts";
import { operateSession, type OperateSessionError } from "../workflows/operate-session.ts";
import { startSession, type StartSessionError } from "../workflows/start-session.ts";
import {
  writeJournalEntry,
  type WriteJournalEntryError,
} from "../workflows/write-journal-entry.ts";
import { journalSqlite, type JournalSqlite } from "./journal-sqlite.ts";
import { sessionSqlite, type SessionSqlite } from "./session-sqlite.ts";
import { migrate } from "./user-do-schema.ts";

// `crypto.randomUUID()` は必ず UUID を返すので、検証に失敗するのは実装の誤り（例外でよい）
const newSessionId = (): SessionId => v.parse(SessionId.schema, crypto.randomUUID());

/**
 * ユーザーごとの Durable Object（ADR 0002）。セッション・操作イベント・ジャーナル記入を持つ。
 *
 * Imperative Shell として、時刻と ID を作り、ワークフローに SQLite の読み書きを渡し、
 * alarm を張るだけにする。判断はすべてワークフローとドメインにある。
 *
 * Durable Object はランタイムの都合でクラス継承が必須（kamae の「クラスを使わない」からの例外）。
 */
export class UserDO extends DurableObject<Env> {
  readonly #sessions: SessionSqlite;
  readonly #journal: JournalSqlite;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // SQLite の API は同期なので、最初のリクエストより前に必ず終わる
    migrate(ctx.storage.sql, new Date());
    this.#sessions = sessionSqlite(ctx.storage.sql);
    this.#journal = journalSqlite(ctx.storage.sql);
  }

  /** `GET /api/session/current` */
  async getCurrentSession(): Promise<SessionSnapshot> {
    return this.#run((now) => getCurrentSession(this.#sessions)(now));
  }

  /** `POST /api/session`。`raw` はリクエストの本文で、検証はワークフローが行う */
  async startSession(raw: unknown): Promise<Result.Result<SessionSnapshot, StartSessionError>> {
    return this.#run((now) => startSession(this.#sessions)(raw, now, newSessionId()));
  }

  /** `POST /api/session/commands`。`raw` はリクエストの本文で、検証はワークフローが行う */
  async operateSession(raw: unknown): Promise<Result.Result<SessionSnapshot, OperateSessionError>> {
    return this.#run((now) => operateSession(this.#sessions)(raw, now));
  }

  // 記入の本文は `Sensitive` に包まれていて RPC で送れない（関数を含む）ため、
  // DO の中で応答の JSON にできる形（`toJson`）にしてから返す（ADR 0010）

  /** `POST /api/journal-entries`。`raw` はリクエストの本文で、検証はワークフローが行う */
  async writeJournalEntry(
    raw: unknown,
  ): Promise<Result.Result<JournalEntryJson, WriteJournalEntryError>> {
    return this.#run((now) =>
      Result.pipe(
        writeJournalEntry({ ...this.#sessions, ...this.#journal })(raw, now),
        Result.map(JournalEntry.toJson),
      ),
    );
  }

  /** `PATCH /api/journal-entries/:id` */
  async editJournalEntry(
    rawId: unknown,
    raw: unknown,
  ): Promise<Result.Result<JournalEntryJson, EditJournalEntryError>> {
    return this.#run((now) =>
      Result.pipe(
        editJournalEntry(this.#journal)(rawId, raw, now),
        Result.map(JournalEntry.toJson),
      ),
    );
  }

  /** `DELETE /api/journal-entries/:id` */
  async deleteJournalEntry(
    rawId: unknown,
  ): Promise<Result.Result<DeletedJournalEntry, DeleteJournalEntryError>> {
    return this.#run((now) => deleteJournalEntry(this.#journal)(rawId, now));
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

  /** 自動終了の時刻に鳴る。自動終了を記録し、まだなら張り直す（`#run` が行う） */
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

  async #applySchedule(schedule: AutoEndSchedule): Promise<void> {
    switch (schedule.kind) {
      case "Scheduled":
        return this.ctx.storage.setAlarm(schedule.at);
      case "NotScheduled":
        return this.ctx.storage.deleteAlarm();
    }
  }
}
