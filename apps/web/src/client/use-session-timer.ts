import { useCallback, useEffect, useRef, useState } from "react";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { ClockOffset } from "../domain/clock-offset.ts";
import { phaseChangeBetween } from "../domain/phase-change.ts";
import { SessionEventId, type SessionOperation } from "../domain/session-event.ts";
import { Session, SessionSnapshot } from "../domain/session.ts";
import type { Ended, TimerState } from "../domain/timer-state.ts";
import type { BackendError } from "../domain/backend.ts";
import { useBackend } from "./backend.ts";
import type { PhaseAlert } from "./phase-alert.ts";
import { startTicker } from "./ticker.ts";

/** カウントダウンを描き直す間隔。表示は秒単位なので、秒の変わり目から遅れても 1/4 秒まで */
const TICK_MS = 250;

/** 受け取ったスナップショットと、そのときに測った時計のずれ */
type Received = Readonly<{ snapshot: SessionSnapshot; offset: ClockOffset }>;

type Loading =
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "LoadFailed" }>
  | Readonly<{ kind: "Loaded"; received: Received }>;

/** 画面に出すタイマーの様子 */
export type TimerView =
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "LoadFailed" }>
  | Readonly<{ kind: "NoSession" }>
  | Readonly<{
      kind: "InSession";
      session: Session;
      state: Exclude<TimerState, Ended>;
      operations: ReadonlyArray<SessionOperation["kind"]>;
    }>
  /** 終了した（自動終了を含む）。次のセッションを開始できる */
  | Readonly<{ kind: "Ended"; session: Session; state: Ended }>;

/**
 * 端末の時刻 `deviceNow` のタイマーの様子。
 *
 * スナップショットの操作イベントから、時計のずれで補正したサーバーの時刻での状態を計算し直す
 * （ADR 0003）。状態とできる操作の判断はドメインの関数に任せる。
 */
const timerViewOf = (loading: Loading, deviceNow: Date): TimerView => {
  if (loading.kind !== "Loaded") {
    return loading;
  }
  const { snapshot, offset } = loading.received;
  if (snapshot.kind === "NoSession") {
    return { kind: "NoSession" };
  }
  const serverNow = ClockOffset.serverNow(offset, deviceNow, snapshot.serverTime);
  const state = Session.stateAt(snapshot.session, serverNow);
  return state.kind === "Ended"
    ? { kind: "Ended", session: snapshot.session, state }
    : {
        kind: "InSession",
        session: snapshot.session,
        state,
        operations: Session.availableOperations(snapshot.session, serverNow),
      };
};

/** 画面に出す失敗の文言。サーバーの文言はそのまま出さない */
const messageOf = (error: BackendError): string => {
  switch (error.kind) {
    case "Unreachable":
      return "通信できませんでした。もう一度お試しください。";
    case "Rejected":
    case "StorageFailed":
    case "Broken":
      return "操作できませんでした。最新の状態を読み込み直しました。";
  }
};

// `crypto.randomUUID()` は必ず UUID を返すので、検証に失敗するのは実装の誤り（例外でよい）
const newEventId = (): SessionEventId => v.parse(SessionEventId.schema, crypto.randomUUID());

/**
 * 端末の時刻。E2E がページの時計を進めて自動的な切り替わりを確かめられるよう、
 * 時刻はかならず `Date.now()` から読む（tests/timer.e2e.ts）
 */
const readDeviceClock = (): Date => new Date(Date.now());

/** API を呼び、送ってから受け取るまでの端末の時刻で時計のずれを測る */
const receive = async (
  call: () => Result.ResultAsync<SessionSnapshot, BackendError>,
): Result.ResultAsync<Received, BackendError> => {
  const requestedAt = readDeviceClock();
  const result = await call();
  const receivedAt = readDeviceClock();
  return Result.pipe(
    result,
    Result.map((snapshot) => ({
      snapshot,
      offset: ClockOffset.measure({ requestedAt, receivedAt, serverTime: snapshot.serverTime }),
    })),
  );
};

/**
 * 手元の読み込みの状態に、届いたスナップショットを反映する。手元より古いものは捨てる（ADR 0012）。
 * HTTP の応答と同期メッセージは、同じ変更について順序が入れ替わって届くことがあるため。
 */
const applyReceived = (current: Loading, received: Received): Loading =>
  current.kind === "Loaded" && SessionSnapshot.isOlder(received.snapshot, current.received.snapshot)
    ? current
    : { kind: "Loaded", received };

/**
 * タイマー画面の状態と操作。
 *
 * - 現在のセッションを読み込み、`TICK_MS` ごとに端末の時刻で状態を計算し直す
 * - 時間が過ぎてフェーズが切り替わったら、`phaseAlert` で音とブラウザ通知で知らせる
 * - 操作はボタンから受け取り、API に送って返ってきたスナップショットに置き換える
 * - 他のタブ・端末での変更は、同期メッセージで届いたスナップショットに置き換える（`receive`）
 */
export const useSessionTimer = (
  phaseAlert: PhaseAlert,
): Readonly<{
  view: TimerView;
  /** 最後に受け取ったスナップショットのセッション（終了したばかりのものを含む）。タイムラインに重ねる */
  session: Session | undefined;
  /** 時計のずれで補正した、サーバーの今の時刻の見積もり */
  serverNow: Date;
  /** 操作を送っている途中。ボタンを押せなくして、二重に送らないようにする */
  pending: boolean;
  /** 直前の操作の失敗 */
  errorMessage: string | undefined;
  start: () => void;
  operate: (kind: SessionOperation["kind"]) => void;
  reload: () => void;
  /** 画面を「読み込み中」にせず、今の状態を読み込み直す（ジャーナル記入で自動終了の時刻が延びたときなど） */
  refresh: () => void;
  /**
   * 同期メッセージで届いたスナップショットに置き換える（ADR 0012）。送った時刻がわからないので
   * 時計のずれは測り直さず、直前に測ったものを使う。まだ読み込めていなければ、読み込みの結果を待つ
   */
  receive: (snapshot: SessionSnapshot) => void;
}> => {
  const backend = useBackend();
  const [loading, setLoading] = useState<Loading>({ kind: "Loading" });
  const [deviceNow, setDeviceNow] = useState(readDeviceClock);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    const result = await receive(backend.getCurrentSession);
    if (Result.isSuccess(result)) {
      const received = result.value;
      setLoading((current) => applyReceived(current, received));
      return;
    }
    setLoading((current) => (current.kind === "Loaded" ? current : { kind: "LoadFailed" }));
  }, [backend]);

  useEffect(() => {
    void load();
  }, [load]);

  // 隠れたタブでも遅れずに切り替わりに気づけるよう、Worker で刻む（ticker.ts、Issue #45）
  useEffect(() => startTicker(TICK_MS, () => setDeviceNow(readDeviceClock())), []);

  // ページを開き直したあとは、最初に画面に触れたときに音を鳴らせるようにする（ブラウザの制約）
  useEffect(() => {
    const unlock = () => phaseAlert.unlockSound();
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, [phaseAlert]);

  const view = timerViewOf(loading, deviceNow);

  // 同じスナップショット（＝同じ操作イベント）から計算した前回の状態と比べる。
  // スナップショットが替わったのは人の操作なので、知らせずに比べる相手だけを替える
  const previous = useRef<Readonly<{ snapshot: SessionSnapshot; state: TimerState }>>(undefined);
  const received = loading.kind === "Loaded" ? loading.received : undefined;
  const state = view.kind === "InSession" || view.kind === "Ended" ? view.state : undefined;
  const serverNow =
    received === undefined
      ? deviceNow
      : ClockOffset.serverNow(received.offset, deviceNow, received.snapshot.serverTime);
  useEffect(() => {
    if (received === undefined || state === undefined) {
      previous.current = undefined;
      return;
    }
    const last = previous.current;
    if (last !== undefined && last.snapshot === received.snapshot) {
      const change = phaseChangeBetween(last.state, state);
      if (change.kind === "PhaseChanged") {
        phaseAlert.alert(change.to);
      }
    }
    previous.current = { snapshot: received.snapshot, state };
  }, [received, state, phaseAlert]);

  const send = async (call: () => Result.ResultAsync<SessionSnapshot, BackendError>) => {
    setPending(true);
    setErrorMessage(undefined);
    const result = await receive(call);
    if (Result.isSuccess(result)) {
      const received = result.value;
      setLoading((current) => applyReceived(current, received));
    } else {
      setErrorMessage(messageOf(result.error));
      // 別のタブで操作したなどで食い違っているかもしれないので、今の状態を読み込み直す
      if (result.error.kind !== "Unreachable") {
        await load();
      }
    }
    setPending(false);
  };

  const snapshot = received?.snapshot;
  return {
    view,
    session: snapshot?.kind === "Session" ? snapshot.session : undefined,
    serverNow,
    pending,
    errorMessage,
    start: () => {
      // 通知の許可と音の準備は、ボタンを押した操作の中でしかできない
      phaseAlert.prepare();
      const id = newEventId();
      void send(() => backend.startSession(id));
    },
    operate: (kind) => {
      phaseAlert.unlockSound();
      const id = newEventId();
      void send(() => backend.operateSession(id, kind));
    },
    reload: () => {
      setLoading({ kind: "Loading" });
      void load();
    },
    refresh: () => {
      void load();
    },
    receive: (snapshot) => {
      setLoading((current) =>
        current.kind === "Loaded"
          ? applyReceived(current, { snapshot, offset: current.received.offset })
          : current,
      );
    },
  };
};

export type SessionTimer = ReturnType<typeof useSessionTimer>;
