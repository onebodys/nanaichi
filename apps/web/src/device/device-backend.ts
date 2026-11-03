import { Result } from "@praha/byethrow";
import type { Backend, BackendError, SyncHandlers } from "../domain/backend.ts";
import { JournalCalendar } from "../domain/journal-calendar.ts";
import type { SessionId } from "../domain/session.ts";
import { SyncMessage } from "../domain/sync-message.ts";
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
import { createDeviceRun, type DeviceRunDeps } from "./device-run.ts";
import { recordsDeps, type RecordsDeps } from "./records.ts";

/** タブのあいだで同期メッセージを送り合う口。ブラウザでは BroadcastChannel で、送った口自身には届かない */
export type SyncChannel = Readonly<{
  post: (data: string) => void;
  listen: (onData: (data: unknown) => void) => () => void;
}>;

export type DeviceBackendDeps = DeviceRunDeps &
  Readonly<{
    channel: SyncChannel;
    newSessionId: () => SessionId;
  }>;

type Command<T, E> = (deps: RecordsDeps, now: Date) => Result.Result<Executed<T>, E>;

const read =
  <T, E>(workflow: (deps: RecordsDeps, now: Date) => Result.Result<T, E>): Command<T, E> =>
  (deps, now) =>
    Result.pipe(
      workflow(deps, now),
      Result.map((value) => ({ value, messages: [] })),
    );

/**
 * この端末の記録で動く `Backend`。UserDO（server/user-do.ts）と同じワークフローを、
 * HTTP のルートが渡すのと同じ形の入力で呼ぶので、入力の検証も断る判断も同じになる。
 */
export const createDeviceBackend = ({
  channel,
  newSessionId,
  ...runDeps
}: DeviceBackendDeps): Backend => {
  const deviceRun = createDeviceRun(runDeps);
  const subscribers = new Set<SyncHandlers>();

  const deliver = (messages: ReadonlyArray<SyncMessage>) => {
    for (const message of messages) {
      channel.post(SyncMessage.serialize(message));
      subscribers.forEach((handlers) => handlers.onMessage(message));
    }
  };

  // 想定内の失敗（Rejected）でも、そのとき確定した自動終了は保存する
  const run = async <T, E extends WorkflowError>(
    command: Command<T, E>,
  ): Promise<Result.Result<T, BackendError>> =>
    Result.pipe(
      await deviceRun((draft, now) => command(recordsDeps(draft), now)),
      Result.andThen((result) =>
        Result.pipe(
          result,
          Result.mapError((error): BackendError => ({
            kind: "Rejected",
            code: rejectionCodeOf(error),
          })),
        ),
      ),
      Result.inspect(({ messages }) => deliver(messages)),
      Result.map(({ value }) => value),
    );

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
