import { useCallback, useEffect, useState } from "react";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { JournalEntryId, type JournalEntry } from "../domain/journal-entry.ts";
import type { Session } from "../domain/session.ts";
import { TAG_KINDS_MAX, type TagName } from "../domain/tag.ts";
import {
  Timeline,
  type TimelineCursor,
  type TimelineDay,
  type TimelineSession,
} from "../domain/timeline.ts";
import { createApiClient, type ApiError } from "./api.ts";

const api = createApiClient();

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
  | Readonly<{ kind: "Loaded"; days: ReadonlyArray<TimelineDay>; hasMore: boolean }>;

/** 送信に失敗した記入。同じ本文とタグを送り直すときは同じ ID を使い、二重に書かないようにする（ADR 0010） */
type FailedDraft = Readonly<{ id: JournalEntryId; body: string; tags: ReadonlyArray<TagName> }>;

const isSameDraft = (draft: FailedDraft, body: string, tags: ReadonlyArray<TagName>): boolean =>
  draft.body === body &&
  draft.tags.length === tags.length &&
  draft.tags.every((tag, i) => tag === tags[i]);

/** 画面に出す失敗の文言。サーバーの文言はそのまま出さない */
const messageOf = (error: ApiError): string => {
  if (error.kind === "NetworkError") {
    return "通信できませんでした。もう一度お試しください。";
  }
  if (error.kind === "ApiRejected" && error.code === "NO_SESSION_IN_PROGRESS") {
    return "セッションの外では書けません。";
  }
  if (error.kind === "ApiRejected" && error.code === "TAG_LIMIT_EXCEEDED") {
    return `タグは${TAG_KINDS_MAX}種類までです。使っていないタグを外してください。`;
  }
  if (error.kind === "ApiRejected" && error.code === "JOURNAL_ENTRY_NOT_FOUND") {
    return "この記入は削除されています。";
  }
  return "保存できませんでした。";
};

const redirectToLoginIfSignedOut = (error: ApiError) => {
  if (error.kind === "ApiRejected" && error.code === "UNAUTHENTICATED") {
    window.location.href = "/login";
  }
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
}> => {
  const [loading, setLoading] = useState<Loading>({ kind: "Loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [failedDraft, setFailedDraft] = useState<FailedDraft | undefined>(undefined);

  /** 読み込んだ記録を更新する。まだ読み込めていなければ何もしない */
  const update = useCallback((change: (loaded: Loaded) => Loaded) => {
    setLoading((state) => (state.kind === "Loaded" ? change(state) : state));
  }, []);

  const loadLatest = useCallback(async () => {
    const result = await api.getTimeline();
    if (Result.isSuccess(result)) {
      const page = result.value;
      setLoading((state) =>
        state.kind === "Loaded"
          ? // 古いページを読み込み済みなら、その続きの位置（next）はそのまま使う
            { ...state, sessions: Timeline.merge(state.sessions, page.sessions) }
          : { kind: "Loaded", sessions: page.sessions, next: page.next },
      );
      return;
    }
    redirectToLoginIfSignedOut(result.error);
    setLoading((state) => (state.kind === "Loaded" ? state : { kind: "LoadFailed" }));
  }, []);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  // タイマーのスナップショットのほうが新しいので、受け取るたびに重ねる（開始・操作・終了）
  useEffect(() => {
    if (current !== undefined) {
      update((loaded) => ({
        ...loaded,
        sessions: Timeline.withCurrentSession(loaded.sessions, current),
      }));
    }
  }, [current, update]);

  const fail = (error: ApiError) => {
    redirectToLoginIfSignedOut(error);
    setErrorMessage(messageOf(error));
  };

  const view: TimelineView =
    loading.kind === "Loaded"
      ? {
          kind: "Loaded",
          days: Timeline.build({
            sessions: loading.sessions,
            next: loading.next,
            now: serverNow,
            timeZone: deviceTimeZone(),
          }),
          hasMore: loading.next.kind === "More",
        }
      : loading;

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
      const result = await api.writeJournalEntry(id, body, tags);
      if (Result.isFailure(result)) {
        setFailedDraft({ id, body, tags });
        fail(result.error);
        return false;
      }
      setFailedDraft(undefined);
      const entry = result.value;
      update((loaded) => ({ ...loaded, sessions: Timeline.putEntry(loaded.sessions, entry) }));
      onWritten();
      return true;
    },
    edit: async (id, body, tags) => {
      setErrorMessage(undefined);
      const result = await api.editJournalEntry(id, body, tags);
      if (Result.isFailure(result)) {
        fail(result.error);
        return false;
      }
      const entry = result.value;
      update((loaded) => ({ ...loaded, sessions: Timeline.putEntry(loaded.sessions, entry) }));
      return true;
    },
    remove: async (id) => {
      setErrorMessage(undefined);
      const result = await api.deleteJournalEntry(id);
      if (Result.isFailure(result)) {
        fail(result.error);
        return;
      }
      update((loaded) => ({ ...loaded, sessions: Timeline.removeEntry(loaded.sessions, id) }));
    },
    loadMore: () => {
      if (loading.kind !== "Loaded" || loading.next.kind !== "More" || loadingMore) {
        return;
      }
      const { before } = loading.next;
      setLoadingMore(true);
      void api.getTimeline(before).then((result) => {
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
      update((loaded) => ({ ...loaded, sessions: Timeline.putEntry(loaded.sessions, entry) }));
    },
    receiveDeletion: (id) => {
      update((loaded) => ({ ...loaded, sessions: Timeline.removeEntry(loaded.sessions, id) }));
    },
  };
};

export type TimelineState = ReturnType<typeof useTimeline>;
