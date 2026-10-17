import { useEffect, useRef } from "react";
import type { SyncMessage } from "../domain/sync-message.ts";
import { connectSync, openBrowserSocket } from "./sync-connection.ts";
import type { SessionTimer } from "./use-session-timer.ts";
import type { TimelineState } from "./use-timeline.ts";

/** 同期の WebSocket の URL。SPA と API は同じ origin なので、ログインの cookie はそのまま送られる */
const syncUrl = (): string => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/ws`;
};

/** 同期メッセージを、タイマーとタイムラインのどちらに反映するか振り分ける */
const deliver = (message: SyncMessage, timer: SessionTimer, timeline: TimelineState): void => {
  switch (message.kind) {
    case "SessionChanged":
      return timer.receive(message.snapshot);
    case "JournalEntrySaved":
      return timeline.receiveEntry(message.entry);
    case "JournalEntryDeleted":
      return timeline.receiveDeletion(message.deleted.id);
  }
};

/**
 * 複数タブ・複数デバイスの同期（ADR 0012）。ホームを開いている間、同期の WebSocket を張り続ける。
 *
 * - 繋がるたびに（初回も繋ぎ直しも）タイマーとタイムラインを読み込み直し、切れていた間の変更を取り込む
 * - 届いた同期メッセージで、タイマーの状態とタイムラインを更新する
 * - 画面に戻ってきたとき・オンラインに戻ったときは、繋がっているかをすぐ確かめる
 */
export const useSync = (timer: SessionTimer, timeline: TimelineState): void => {
  // 接続は開いている間ずっと1つなので、最新の timer と timeline を参照で渡す
  const latest = useRef({ timer, timeline });
  useEffect(() => {
    latest.current = { timer, timeline };
  });

  useEffect(() => {
    const connection = connectSync(
      {
        onConnected: () => {
          latest.current.timer.refresh();
          latest.current.timeline.refresh();
        },
        onMessage: (message) => deliver(message, latest.current.timer, latest.current.timeline),
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
