import { useCallback, useEffect, useRef, useState } from "react";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { JournalEntryId, type JournalEntry } from "../domain/journal-entry.ts";
import type { Session } from "../domain/session.ts";
import { TAG_KINDS_MAX, type DeletedTag, type TagName } from "../domain/tag.ts";
import {
  Timeline,
  type DayCompletedSets,
  type TimelineCursor,
  type TimelineDay,
  type TimelineSession,
} from "../domain/timeline.ts";
import type { ApiErrorCode } from "../domain/api-error.ts";
import type { BackendError } from "../domain/backend.ts";
import { storageFailedMessageOf } from "./storage-failed-text.ts";
import { useBackend } from "./backend.ts";
import { mergeLatestPage, type TimelineChange } from "./timeline-changes.ts";

// `crypto.randomUUID()` は必ず UUID を返すので、検証に失敗するのは実装の誤り（例外でよい）
const newEntryId = (): JournalEntryId => v.parse(JournalEntryId.schema, crypto.randomUUID());

/** 端末のタイムゾーン。日付はこのタイムゾーンの 0:00 で区切る（ADR 0011） */
const deviceTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

type Loaded = Readonly<{
  kind: "Loaded";
  sessions: ReadonlyArray<TimelineSession>;
  next: TimelineCursor;
}>;

type Loading = Readonly<{ kind: "Loading" }> | Readonly<{ kind: "LoadFailed" }> | Loaded;

/** 画面に出すタイムラインの様子 */
export type TimelineView =
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "LoadFailed" }>
  | Readonly<{
      kind: "Loaded";
      days: ReadonlyArray<TimelineDay>;
      hasMore: boolean;
      /** 今日（端末のタイムゾーン）の完了セット数。ヘッダーの今日の集中時間に使う */
      today: DayCompletedSets;
    }>;

/** 送信に失敗した記入。同じ本文とタグを送り直すときは同じ ID を使い、二重に書かないようにする（ADR 0010） */
type FailedDraft = Readonly<{ id: JournalEntryId; body: string; tags: ReadonlyArray<TagName> }>;

const isSameDraft = (draft: FailedDraft, body: string, tags: ReadonlyArray<TagName>): boolean =>
  draft.body === body &&
  draft.tags.length === tags.length &&
  draft.tags.every((tag, i) => tag === tags[i]);

/** 画面に出す失敗の文言。サーバーの文言はそのまま出さない */
const messageOf = (error: BackendError): string => {
  switch (error.kind) {
    case "Unreachable":
      return "通信できませんでした。もう一度お試しください。";
    case "Rejected":
      return rejectedMessageOf(error.code);
    case "StorageFailed":
      return storageFailedMessageOf(error);
    case "Broken":
      return "保存できませんでした。";
  }
};

const rejectedMessageOf = (code: ApiErrorCode): string => {
  if (code === "NO_SESSION_IN_PROGRESS") {
    return "セッションの外では書けません。";
  }
  if (code === "TAG_LIMIT_EXCEEDED") {
    return `タグは${TAG_KINDS_MAX}種類までです。使っていないタグを外してください。`;
  }
  if (code === "JOURNAL_ENTRY_NOT_FOUND") {
    return "この記入は削除されています。";
  }
  return "保存できませんでした。";
};

/**
 * タイムラインの状態と、ジャーナル記入の書く・編集・削除。
 *
 * - 最新のページを読み込み、「さらに読み込む」で古いページを足す（ADR 0011）
 * - タイマーのスナップショットのセッションを重ね、進行中・終了したばかりのセッションを新しく保つ
 * - 他のタブ・端末で書いた・編集した・削除した記入は、同期メッセージで受け取って反映する（ADR 0012）
 * - 日付の区切りと完了セット数は、サーバーの今の時刻の見積もりと端末のタイムゾーンでドメインが組み立てる
 *
 * - `current`: タイマーが最後に受け取ったセッション
 * - `serverNow`: 時計のずれで補正したサーバーの今の時刻
 * - `onWritten`: 記入を書いたあとに呼ぶ（自動終了の時刻が延びるので、タイマーが読み込み直す。タグの候補も変わる）
 */
export const useTimeline = (
  current: Session | undefined,
  serverNow: Date,
  onWritten: () => void,
): Readonly<{
  view: TimelineView;
  loadingMore: boolean;
  errorMessage: string | undefined;
  /** 記入を書く。成功したら true（入力欄を空にする） */
  write: (body: string, tags: ReadonlyArray<TagName>) => Promise<boolean>;
  /** 記入の本文とタグを書き直す。成功したら true（編集を閉じる） */
  edit: (id: JournalEntryId, body: string, tags: ReadonlyArray<TagName>) => Promise<boolean>;
  remove: (id: JournalEntryId) => Promise<void>;
  loadMore: () => void;
  reload: () => void;
  /** 画面を「読み込み中」にせず、最新のページを読み込み直す（同期が繋がったときなど） */
  refresh: () => void;
  /** 同期メッセージで届いた、書いた・編集した記入を反映する */
  receiveEntry: (entry: JournalEntry) => void;
  /** 同期メッセージで届いた、削除した記入を取り除く */
  receiveDeletion: (id: JournalEntryId) => void;
  /** 削除したタグを、読み込んだ記入から外す（自分で削除したときも、同期メッセージで届いたときも） */
  receiveTagDeletion: (deleted: DeletedTag) => void;
}> => {
  const backend = useBackend();
  const [loading, setLoading] = useState<Loading>({ kind: "Loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [failedDraft, setFailedDraft] = useState<FailedDraft | undefined>(undefined);

  /** 読み込んだ記録を更新する。まだ読み込めていなければ何もしない */
  const update = useCallback((change: (loaded: Loaded) => Loaded) => {
    setLoading((state) => (state.kind === "Loaded" ? change(state) : state));
  }, []);

  // 最新のページを読み込んでいる間に当てた変更。応答が届いたら、ページの上に当て直す（`mergeLatestPage`）
  const changesWhileLoading = useRef<Array<Readonly<{ seq: number; change: TimelineChange }>>>([]);
  const lastSeq = useRef(0);
  const loadsInFlight = useRef(0);

  /** 記入やセッションの変更を当てる。最新のページを読み込んでいる間なら、当て直すために覚えておく */
  const apply = useCallback(
    (change: TimelineChange) => {
      if (loadsInFlight.current > 0) {
        lastSeq.current += 1;
        changesWhileLoading.current.push({ seq: lastSeq.current, change });
      }
      update((loaded) => ({ ...loaded, sessions: change(loaded.sessions) }));
    },
    [update],
  );

  const loadLatest = useCallback(async () => {
    const since = lastSeq.current;
    loadsInFlight.current += 1;
    const result = await backend.getTimeline();
    loadsInFlight.current -= 1;
    const changes = changesWhileLoading.current
      .filter(({ seq }) => seq > since)
      .map(({ change }) => change);
    if (loadsInFlight.current === 0) {
      changesWhileLoading.current = [];
    }
    if (Result.isSuccess(result)) {
      const page = result.value;
      setLoading((state) =>
        state.kind === "Loaded"
          ? // 古いページを読み込み済みなら、その続きの位置（next）はそのまま使う
            { ...state, sessions: mergeLatestPage(state.sessions, page.sessions, changes) }
          : {
              kind: "Loaded",
              sessions: mergeLatestPage([], page.sessions, changes),
              next: page.next,
            },
      );
      return;
    }
    setLoading((state) => (state.kind === "Loaded" ? state : { kind: "LoadFailed" }));
  }, [backend]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  // タイマーのスナップショットのほうが新しいので、受け取るたびに重ねる（開始・操作・終了）
  useEffect(() => {
    if (current !== undefined) {
      // 描画中の計算にはできない。重ねたセッションは手元の記録に残し続ける必要がある。残さないと、
      // 次のセッションを始めたときに前のセッションが古い内容に戻り、始めたばかりのセッションへの記入も捨てられる
      // oxlint-disable-next-line react/set-state-in-effect
      apply((sessions) => Timeline.withCurrentSession(sessions, current));
    }
  }, [current, apply]);

  const fail = (error: BackendError) => {
    setErrorMessage(messageOf(error));
  };

  const view = ((): TimelineView => {
    if (loading.kind !== "Loaded") {
      return loading;
    }
    const timeZone = deviceTimeZone();
    const days = Timeline.build({
      sessions: loading.sessions,
      next: loading.next,
      now: serverNow,
      timeZone,
    });
    return {
      kind: "Loaded",
      days,
      hasMore: loading.next.kind === "More",
      today: Timeline.completedSetsOn(days, serverNow, timeZone),
    };
  })();

  return {
    view,
    loadingMore,
    errorMessage,
    write: async (body, tags) => {
      setErrorMessage(undefined);
      const id =
        failedDraft !== undefined && isSameDraft(failedDraft, body, tags)
          ? failedDraft.id
          : newEntryId();
      const result = await backend.writeJournalEntry(id, body, tags);
      if (Result.isFailure(result)) {
        setFailedDraft({ id, body, tags });
        fail(result.error);
        return false;
      }
      setFailedDraft(undefined);
      const entry = result.value;
      apply((sessions) => Timeline.putEntry(sessions, entry));
      onWritten();
      return true;
    },
    edit: async (id, body, tags) => {
      setErrorMessage(undefined);
      const result = await backend.editJournalEntry(id, body, tags);
      if (Result.isFailure(result)) {
        fail(result.error);
        return false;
      }
      const entry = result.value;
      apply((sessions) => Timeline.putEntry(sessions, entry));
      return true;
    },
    remove: async (id) => {
      setErrorMessage(undefined);
      const result = await backend.deleteJournalEntry(id);
      if (Result.isFailure(result)) {
        fail(result.error);
        return;
      }
      apply((sessions) => Timeline.removeEntry(sessions, id));
    },
    loadMore: () => {
      if (loading.kind !== "Loaded" || loading.next.kind !== "More" || loadingMore) {
        return;
      }
      const { before } = loading.next;
      setLoadingMore(true);
      void backend.getTimeline(before).then((result) => {
        setLoadingMore(false);
        if (Result.isFailure(result)) {
          fail(result.error);
          return;
        }
        const page = result.value;
        update((loaded) => ({
          ...loaded,
          sessions: Timeline.merge(loaded.sessions, page.sessions),
          next: page.next,
        }));
      });
    },
    reload: () => {
      setLoading({ kind: "Loading" });
      void loadLatest();
    },
    refresh: () => {
      void loadLatest();
    },
    receiveEntry: (entry) => {
      apply((sessions) => Timeline.putEntry(sessions, entry));
    },
    receiveDeletion: (id) => {
      apply((sessions) => Timeline.removeEntry(sessions, id));
    },
    receiveTagDeletion: (deleted) => {
      apply((sessions) => Timeline.deleteTag(sessions, deleted));
    },
  };
};

export type TimelineState = ReturnType<typeof useTimeline>;
