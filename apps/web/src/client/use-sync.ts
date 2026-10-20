import { useEffect, useRef } from "react";
import type { SyncMessage } from "../domain/sync-message.ts";
import { connectSync, openBrowserSocket } from "./sync-connection.ts";
import type { AdvanceModeState } from "./use-advance-mode.ts";
import type { SessionTimer } from "./use-session-timer.ts";
import { applyTagDeletionToAttached } from "./use-attached-tags.ts";
import type { TagUsageState } from "./use-tag-usage.ts";
import type { TagsState } from "./use-tags.ts";
import type { TimelineState } from "./use-timeline.ts";

/** 同期の WebSocket の URL。SPA と API は同じ origin なので、ログインの cookie はそのまま送られる */
const syncUrl = (): string => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/ws`;
};

type Receivers = Readonly<{
  timer: SessionTimer;
  timeline: TimelineState;
  tags: TagsState;
  tagUsage: TagUsageState;
  advanceMode: AdvanceModeState;
}>;

/**
 * 同期メッセージを、タイマーとタイムラインのどちらに反映するか振り分ける。
 * 記入が変わるとタグの使われ方も変わるので、タグの候補と設定画面のタグの一覧を読み込み直す
 */
const deliver = (
  message: SyncMessage,
  { timer, timeline, tags, tagUsage, advanceMode }: Receivers,
): void => {
  switch (message.kind) {
    case "SessionChanged":
      return timer.receive(message.snapshot);
    case "JournalEntrySaved":
      timeline.receiveEntry(message.entry);
      tags.refresh();
      return tagUsage.refresh();
    case "JournalEntryDeleted":
      timeline.receiveDeletion(message.deleted.id);
      tags.refresh();
      return tagUsage.refresh();
    case "TagDeleted":
      // 書き換えた記入は届かないので、読み込んだ記入とつけたままのタグに同じ削除を当てる（ADR 0017）
      timeline.receiveTagDeletion(message.deleted);
      applyTagDeletionToAttached(message.deleted);
      tags.refresh();
      return tagUsage.refresh();
    case "AdvanceModeChanged":
      return advanceMode.receive(message.mode);
  }
};

/**
 * 複数タブ・複数デバイスの同期（ADR 0012）。ホームを開いている間、同期の WebSocket を張り続ける。
 *
 * - 繋がるたびに（初回も繋ぎ直しも）タイマーとタイムラインとタグの候補とフェーズの進め方を読み込み直し、
 *   切れていた間の変更を取り込む
 * - 届いた同期メッセージで、タイマーの状態とタイムラインを更新する
 * - 画面に戻ってきたとき・オンラインに戻ったときは、繋がっているかをすぐ確かめる
 */
export const useSync = (receivers: Receivers): void => {
  // 接続は開いている間ずっと1つなので、最新の受け取り手を参照で渡す
  const latest = useRef<Receivers>(receivers);
  useEffect(() => {
    latest.current = receivers;
  });

  useEffect(() => {
    const connection = connectSync(
      {
        onConnected: () => {
          latest.current.timer.refresh();
          latest.current.timeline.refresh();
          latest.current.tags.refresh();
          latest.current.tagUsage.refresh();
          latest.current.advanceMode.refresh();
        },
        onMessage: (message) => deliver(message, latest.current),
      },
      openBrowserSocket(syncUrl()),
    );
    const checkIfVisible = () => {
      if (document.visibilityState === "visible") {
        connection.check();
      }
    };
    document.addEventListener("visibilitychange", checkIfVisible);
    window.addEventListener("online", connection.check);
    return () => {
      document.removeEventListener("visibilitychange", checkIfVisible);
      window.removeEventListener("online", connection.check);
      connection.close();
    };
  }, []);
};
