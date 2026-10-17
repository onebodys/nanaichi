import { Result } from "@praha/byethrow";
import { schemaResult } from "../domain/schema-result.ts";
import { SyncMessageJsonSchema, type SyncMessage } from "../domain/sync-message.ts";

/**
 * 同期の WebSocket（`GET /api/ws`、ADR 0012）を張り続ける。
 *
 * - 繋がるたびに（初回も繋ぎ直しも）`onConnected` を呼ぶ。切れている間の同期メッセージは届かないので、
 *   画面はここでスナップショットとタイムラインを読み込み直す
 * - 届いた同期メッセージはスキーマで検証してから `onMessage` に渡す。合わないものは捨てる
 * - 切れたら、間隔を延ばしながら（最大30秒）繋ぎ直す
 * - スリープなどで切れたことに気づけない接続を見つけるため、一定間隔で `ping` を送り、
 *   `pong` が返らなければ切って繋ぎ直す
 */

/** 最初の繋ぎ直しまでの間隔。失敗が続くたびに倍にする */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/** `ping` を送る間隔 */
const PING_INTERVAL_MS = 25_000;
/** `ping` を送ってから `pong` を待つ時間。過ぎたら切れているとみなす */
const PONG_TIMEOUT_MS = 10_000;

/** 開いた WebSocket のうち、使うところだけ */
type SyncSocket = Readonly<{
  send: (data: string) => void;
  close: () => void;
}>;

/** WebSocket を開き、イベントを受け取る関数を登録する（テストで差し替える。画面では `openBrowserSocket`） */
export type OpenSyncSocket = (
  events: Readonly<{ onOpen: () => void; onMessage: (data: unknown) => void; onClose: () => void }>,
) => SyncSocket;

/** ブラウザの WebSocket で `url` に繋ぐ */
export const openBrowserSocket =
  (url: string): OpenSyncSocket =>
  ({ onOpen, onMessage, onClose }) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", onOpen);
    ws.addEventListener("message", (event) => onMessage(event.data));
    ws.addEventListener("close", onClose);
    return { send: (data) => ws.send(data), close: () => ws.close() };
  };

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

const parseMessage = schemaResult(SyncMessageJsonSchema);

/** 届いた文字列を同期メッセージにする。JSON でないか、スキーマに合わなければ undefined */
const decode = (data: unknown): SyncMessage | undefined => {
  if (typeof data !== "string") {
    return undefined;
  }
  const parsed = Result.pipe(
    Result.try({ try: (): unknown => JSON.parse(data), catch: () => undefined }),
    Result.andThen(parseMessage),
  );
  return Result.isSuccess(parsed) ? parsed.value : undefined;
};

/** 接続の状態 */
type Phase =
  | Readonly<{ kind: "Connecting"; socket: SyncSocket }>
  | Readonly<{ kind: "Open"; socket: SyncSocket }>
  /** 繋ぎ直しを待っている */
  | Readonly<{ kind: "Waiting"; timer: ReturnType<typeof setTimeout> }>
  /** `close` を呼んだ。もう繋がない */
  | Readonly<{ kind: "Closed" }>;

export const connectSync = (handlers: SyncHandlers, openSocket: OpenSyncSocket): SyncConnection => {
  let phase: Phase;
  /** 続けて失敗した回数。繋がったら 0 に戻す */
  let failures = 0;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;

  const stopHeartbeat = () => {
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    pingTimer = undefined;
    pongTimer = undefined;
  };

  /** 今の接続を捨てる。閉じる手続きの完了は待たない（切れた接続では返ってこないことがある） */
  const discard = (socket: SyncSocket) => {
    stopHeartbeat();
    socket.close();
  };

  const scheduleReconnect = () => {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** failures, RECONNECT_MAX_MS);
    failures += 1;
    phase = { kind: "Waiting", timer: setTimeout(connect, delay) };
  };

  const ping = (socket: SyncSocket) => {
    if (pongTimer !== undefined) {
      return;
    }
    socket.send("ping");
    pongTimer = setTimeout(() => {
      discard(socket);
      scheduleReconnect();
    }, PONG_TIMEOUT_MS);
  };

  /** `socket` がまだ今の接続か。捨てた接続から遅れて届いたイベントは無視する */
  const isCurrent = (socket: SyncSocket) =>
    (phase.kind === "Connecting" || phase.kind === "Open") && phase.socket === socket;

  function connect() {
    const socket = openSocket({
      onOpen: () => {
        if (!isCurrent(socket)) {
          return;
        }
        phase = { kind: "Open", socket };
        failures = 0;
        pingTimer = setInterval(() => ping(socket), PING_INTERVAL_MS);
        handlers.onConnected();
      },
      onMessage: (data) => {
        if (!isCurrent(socket)) {
          return;
        }
        if (data === "pong") {
          clearTimeout(pongTimer);
          pongTimer = undefined;
          return;
        }
        const message = decode(data);
        if (message !== undefined) {
          handlers.onMessage(message);
        }
      },
      onClose: () => {
        if (!isCurrent(socket)) {
          return;
        }
        stopHeartbeat();
        scheduleReconnect();
      },
    });
    phase = { kind: "Connecting", socket };
  }

  connect();

  return {
    check: () => {
      switch (phase.kind) {
        case "Waiting":
          clearTimeout(phase.timer);
          failures = 0;
          connect();
          return;
        case "Open":
          ping(phase.socket);
          return;
        case "Connecting":
        case "Closed":
          return;
      }
    },
    close: () => {
      switch (phase.kind) {
        case "Waiting":
          clearTimeout(phase.timer);
          break;
        case "Connecting":
        case "Open":
          discard(phase.socket);
          break;
        case "Closed":
          break;
      }
      phase = { kind: "Closed" };
    },
  };
};
