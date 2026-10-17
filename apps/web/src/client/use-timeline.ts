import { useCallback, useEffect, useState } from "react";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { JournalEntryId } from "../domain/journal-entry.ts";
import type { Session } from "../domain/session.ts";
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

/** 送信に失敗した記入。同じ本文を送り直すときは同じ ID を使い、二重に書かないようにする（ADR 0010） */
type FailedDraft = Readonly<{ id: JournalEntryId; body: string }>;

/** 画面に出す失敗の文言。サーバーの文言はそのまま出さない */
const messageOf = (error: ApiError): string => {
  if (error.kind === "NetworkError") {
    return "通信できませんでした。もう一度お試しください。";
  }
  if (error.kind === "ApiRejected" && error.code === "NO_SESSION_IN_PROGRESS") {
    return "セッションの外では書けません。";
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
 * - 日付の区切りと完了セット数は、サーバーの今の時刻の見積もりと端末のタイムゾーンでドメインが組み立てる
 *
 * - `current`: タイマーが最後に受け取ったセッション
 * - `serverNow`: 時計のずれで補正したサーバーの今の時刻
 * - `onWritten`: 記入を書いたあとに呼ぶ（自動終了の時刻が延びるので、タイマーが読み込み直す）
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
  write: (body: string) => Promise<boolean>;
  /** 記入を書き直す。成功したら true（編集を閉じる） */
  edit: (id: JournalEntryId, body: string) => Promise<boolean>;
  remove: (id: JournalEntryId) => Promise<void>;
  loadMore: () => void;
  reload: () => void;
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
    write: async (body) => {
      setErrorMessage(undefined);
      const id =
        failedDraft !== undefined && failedDraft.body === body ? failedDraft.id : newEntryId();
      const result = await api.writeJournalEntry(id, body);
      if (Result.isFailure(result)) {
        setFailedDraft({ id, body });
        fail(result.error);
        return false;
      }
      setFailedDraft(undefined);
      const entry = result.value;
      update((loaded) => ({ ...loaded, sessions: Timeline.putEntry(loaded.sessions, entry) }));
      onWritten();
      return true;
    },
    edit: async (id, body) => {
      setErrorMessage(undefined);
      const result = await api.editJournalEntry(id, body);
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
  };
};

export type TimelineState = ReturnType<typeof useTimeline>;
