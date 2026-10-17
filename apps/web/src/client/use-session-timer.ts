import { useCallback, useEffect, useRef, useState } from "react";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { ClockOffset } from "../domain/clock-offset.ts";
import { phaseChangeBetween } from "../domain/phase-change.ts";
import { SessionEventId, type SessionOperation } from "../domain/session-event.ts";
import { Session, type SessionSnapshot } from "../domain/session.ts";
import type { Ended, TimerState } from "../domain/timer-state.ts";
import { createApiClient, type ApiError } from "./api.ts";
import { createPhaseAlert } from "./phase-alert.ts";

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
      state: Exclude<TimerState, Ended>;
      operations: ReadonlyArray<SessionOperation["kind"]>;
    }>
  /** 終了した（自動終了を含む）。次のセッションを開始できる */
  | Readonly<{ kind: "Ended"; state: Ended }>;

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
    ? { kind: "Ended", state }
    : {
        kind: "InSession",
        state,
        operations: Session.availableOperations(snapshot.session, serverNow),
      };
};

/** 画面に出す失敗の文言。サーバーの文言はそのまま出さない */
const messageOf = (error: ApiError): string => {
  switch (error.kind) {
    case "NetworkError":
      return "通信できませんでした。もう一度お試しください。";
    case "ApiRejected":
    case "UnexpectedResponse":
      return "操作できませんでした。最新の状態を読み込み直しました。";
  }
};

// `crypto.randomUUID()` は必ず UUID を返すので、検証に失敗するのは実装の誤り（例外でよい）
const newEventId = (): SessionEventId => v.parse(SessionEventId.schema, crypto.randomUUID());

const api = createApiClient();

/**
 * 端末の時刻。E2E がページの時計を進めて自動的な切り替わりを確かめられるよう、
 * 時刻はかならず `Date.now()` から読む（tests/timer.e2e.ts）
 */
const readDeviceClock = (): Date => new Date(Date.now());

/** API を呼び、送ってから受け取るまでの端末の時刻で時計のずれを測る */
const receive = async (
  call: () => Result.ResultAsync<SessionSnapshot, ApiError>,
): Result.ResultAsync<Received, ApiError> => {
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

const redirectToLoginIfSignedOut = (error: ApiError) => {
  if (error.kind === "ApiRejected" && error.code === "UNAUTHENTICATED") {
    window.location.href = "/login";
  }
};

/**
 * タイマー画面の状態と操作。
 *
 * - 現在のセッションを読み込み、`TICK_MS` ごとに端末の時刻で状態を計算し直す
 * - 時間が過ぎてフェーズが切り替わったら、音とブラウザ通知で知らせる
 * - 操作はボタンから受け取り、API に送って返ってきたスナップショットに置き換える
 */
export const useSessionTimer = (): Readonly<{
  view: TimerView;
  /** 操作を送っている途中。ボタンを押せなくして、二重に送らないようにする */
  pending: boolean;
  /** 直前の操作の失敗 */
  errorMessage: string | undefined;
  start: () => void;
  operate: (kind: SessionOperation["kind"]) => void;
  reload: () => void;
}> => {
  const [loading, setLoading] = useState<Loading>({ kind: "Loading" });
  const [deviceNow, setDeviceNow] = useState(readDeviceClock);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [phaseAlert] = useState(createPhaseAlert);

  const load = useCallback(async () => {
    const result = await receive(api.getCurrentSession);
    if (Result.isSuccess(result)) {
      setLoading({ kind: "Loaded", received: result.value });
      return;
    }
    redirectToLoginIfSignedOut(result.error);
    setLoading((current) => (current.kind === "Loaded" ? current : { kind: "LoadFailed" }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setDeviceNow(readDeviceClock()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

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

  const send = async (call: () => Result.ResultAsync<SessionSnapshot, ApiError>) => {
    setPending(true);
    setErrorMessage(undefined);
    const result = await receive(call);
    if (Result.isSuccess(result)) {
      setLoading({ kind: "Loaded", received: result.value });
    } else {
      redirectToLoginIfSignedOut(result.error);
      setErrorMessage(messageOf(result.error));
      // 別のタブで操作したなどで食い違っているかもしれないので、今の状態を読み込み直す
      if (result.error.kind !== "NetworkError") {
        await load();
      }
    }
    setPending(false);
  };

  return {
    view,
    pending,
    errorMessage,
    start: () => {
      // 通知の許可と音の準備は、ボタンを押した操作の中でしかできない
      phaseAlert.prepare();
      const id = newEventId();
      void send(() => api.startSession(id));
    },
    operate: (kind) => {
      phaseAlert.unlockSound();
      const id = newEventId();
      void send(() => api.operateSession(id, kind));
    },
    reload: () => {
      setLoading({ kind: "Loading" });
      void load();
    },
  };
};
