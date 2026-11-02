import { Result } from "@praha/byethrow";
import type { Backend, BackendError, SyncHandlers } from "../domain/backend.ts";
import { JournalCalendar } from "../domain/journal-calendar.ts";
import type { SessionId } from "../domain/session.ts";
import { SyncMessage } from "../domain/sync-message.ts";
import { settleAutoEnd } from "../workflows/auto-end-session.ts";
import { getAdvanceMode } from "../workflows/get-advance-mode.ts";
import { getCurrentSession } from "../workflows/get-current-session.ts";
import { getEntriesOnDate } from "../workflows/get-entries-on-date.ts";
import { getEntriesWithTag } from "../workflows/get-entries-with-tag.ts";
import { getJournalCalendar } from "../workflows/get-journal-calendar.ts";
import { getStats } from "../workflows/get-stats.ts";
import { getTagUsage } from "../workflows/get-tag-usage.ts";
import { getTags } from "../workflows/get-tags.ts";
import { getTimeline } from "../workflows/get-timeline.ts";
import { rejectionCodeOf, type WorkflowError } from "../workflows/rejection-code.ts";
import {
  changeAdvanceModeCommand,
  deleteJournalEntryCommand,
  deleteTagCommand,
  editJournalEntryCommand,
  operateSessionCommand,
  startSessionCommand,
  writeJournalEntryCommand,
  type Executed,
} from "../workflows/user-commands.ts";
import { deviceNow, recordsDeps, type RecordsDeps } from "./records.ts";
import { VaultContent, type Vault, type VaultFailure } from "./vault.ts";

/** タブのあいだで同期メッセージを送り合う口。ブラウザでは BroadcastChannel で、送った口自身には届かない */
export type SyncChannel = Readonly<{
  post: (data: string) => void;
  listen: (onData: (data: unknown) => void) => () => void;
}>;

export type DeviceBackendDeps = Readonly<{
  vault: Vault;
  /**
   * タブをまたいで1つずつ実行する。開いているセッションは1つという約束がタブをまたぐので、
   * UserDO が1つずつ処理するのと同じく、読み込みから書き込みまでを1つのタブだけが行う
   */
  exclusive: <T>(section: () => Promise<T>) => Promise<T>;
  channel: SyncChannel;
  clock: () => Date;
  newSessionId: () => SessionId;
  /** 保存した記録をブラウザが消さないよう求める。最初に書いたときに1回だけ呼ぶ */
  persist: () => void;
}>;

type Command<T, E> = (deps: RecordsDeps, now: Date) => Result.Result<Executed<T>, E>;

const storageFailed = (failure: VaultFailure): BackendError => {
  switch (failure.kind) {
    case "Unavailable":
    case "QuotaExceeded":
    case "NewerFormat":
      return { kind: "StorageFailed", reason: failure.kind };
    case "Broken":
      return { kind: "Broken" };
  }
};

const read =
  <T, E>(workflow: (deps: RecordsDeps, now: Date) => Result.Result<T, E>): Command<T, E> =>
  (deps, now) =>
    Result.pipe(
      workflow(deps, now),
      Result.map((value) => ({ value, messages: [] })),
    );

/** alarm がないので、UserDO の `#run` と違い、コマンドの前にも自動終了を確定させる */
const withAutoEndSettled =
  <T, E>(command: Command<T, E>): Command<T, E> =>
  (deps, now) => {
    settleAutoEnd(deps)(now);
    const result = command(deps, now);
    settleAutoEnd(deps)(now);
    return result;
  };

/**
 * この端末の記録で動く `Backend`。UserDO（server/user-do.ts）と同じワークフローを、
 * HTTP のルートが渡すのと同じ形の入力で呼ぶので、入力の検証も断る判断も同じになる。
 */
export const createDeviceBackend = ({
  vault,
  exclusive,
  channel,
  clock,
  newSessionId,
  persist,
}: DeviceBackendDeps): Backend => {
  let cache: VaultContent = VaultContent.empty;
  let persistRequested = false;
  const subscribers = new Set<SyncHandlers>();

  const deliver = (messages: ReadonlyArray<SyncMessage>) => {
    for (const message of messages) {
      channel.post(SyncMessage.serialize(message));
      subscribers.forEach((handlers) => handlers.onMessage(message));
    }
  };

  const runExclusively = <T, E extends WorkflowError>(
    command: Command<T, E>,
  ): Promise<Result.Result<Executed<T>, BackendError>> =>
    exclusive(async () => {
      const loaded = await vault.load(cache);
      if (Result.isFailure(loaded)) {
        return Result.fail(storageFailed(loaded.error));
      }
      cache = loaded.value;
      const draft = { base: cache.records, current: cache.records };
      const deps = recordsDeps(draft);
      const now = deviceNow(clock, cache.records);
      let result: Result.Result<Executed<T>, E>;
      try {
        result = withAutoEndSettled(command)(deps, now);
      } catch {
        return Result.fail({ kind: "Broken" } satisfies BackendError);
      }
      if (draft.current !== draft.base) {
        const committed = await vault.commit(cache, draft.current);
        if (Result.isFailure(committed)) {
          return Result.fail(storageFailed(committed.error));
        }
        cache = committed.value;
        if (!persistRequested) {
          persistRequested = true;
          persist();
        }
      }
      return Result.pipe(
        result,
        Result.mapError((error): BackendError => ({
          kind: "Rejected",
          code: rejectionCodeOf(error),
        })),
      );
    });

  const run = async <T, E extends WorkflowError>(
    command: Command<T, E>,
  ): Promise<Result.Result<T, BackendError>> => {
    let result: Result.Result<Executed<T>, BackendError>;
    try {
      result = await runExclusively(command);
    } catch {
      result = Result.fail({ kind: "Broken" });
    }
    return Result.pipe(
      result,
      Result.inspect(({ messages }) => deliver(messages)),
      Result.map(({ value }) => value),
    );
  };

  return {
    getCurrentSession: () => run(read((deps, now) => Result.succeed(getCurrentSession(deps)(now)))),
    startSession: (id) =>
      run((deps, now) => startSessionCommand(deps)({ id }, now, newSessionId())),
    operateSession: (id, kind) =>
      run((deps, now) => operateSessionCommand(deps)({ id, kind }, now)),
    writeJournalEntry: (id, body, tags) =>
      run((deps, now) => writeJournalEntryCommand(deps)({ id, body, tags }, now)),
    editJournalEntry: (id, body, tags) =>
      run((deps, now) => editJournalEntryCommand(deps)(id, { body, tags }, now)),
    deleteJournalEntry: (id) => run((deps, now) => deleteJournalEntryCommand(deps)(id, now)),
    getTimeline: (before) =>
      run(read((deps, now) => getTimeline(deps)({ before: before?.toISOString() }, now))),
    getTags: () => run(read((deps) => getTags(deps)())),
    getTagUsage: () => run(read((deps) => getTagUsage(deps)())),
    deleteTag: (name, deletion) => run((deps) => deleteTagCommand(deps)(name, deletion)),
    getStats: (period, timeZone) =>
      run(read((deps, now) => getStats(deps)({ period, timeZone }, now))),
    getJournalCalendar: (month, timeZone) =>
      run(
        read((deps, now) =>
          getJournalCalendar(deps)({ month: JournalCalendar.keyOfMonth(month), timeZone }, now),
        ),
      ),
    getEntriesOnDate: (date, timeZone) =>
      run(read((deps) => getEntriesOnDate(deps)({ date: date.key, timeZone }))),
    getEntriesWithTag: (tag, before) =>
      run(read((deps) => getEntriesWithTag(deps)({ tag, before: before?.toISOString() }))),
    getAdvanceMode: () => run(read((deps, now) => getAdvanceMode(deps)(now))),
    changeAdvanceMode: (mode) => run((deps, now) => changeAdvanceModeCommand(deps)(mode, now)),

    subscribe: (handlers) => {
      let open = true;
      subscribers.add(handlers);
      const stopListening = channel.listen((data) => {
        const message = SyncMessage.deserialize(data);
        if (open && message !== undefined) {
          handlers.onMessage(message);
        }
      });
      queueMicrotask(() => {
        if (open) {
          handlers.onConnected();
        }
      });
      return {
        check: () => undefined,
        close: () => {
          open = false;
          subscribers.delete(handlers);
          stopListening();
        },
      };
    },
  };
};
