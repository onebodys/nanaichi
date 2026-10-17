import type { SessionOperation } from "../domain/session-event.ts";
import type { Ended, TimerState } from "../domain/timer-state.ts";
import { Button } from "./components/ui/button.tsx";
import { formatCountdown, operationLabelOf, phaseLabelOf, positionOf } from "./timer-text.ts";
import { useSessionTimer, type TimerView } from "./use-session-timer.ts";
import { useWakeLock } from "./wake-lock.ts";

/** 操作ボタンの見た目。止める・閉じる操作は控えめにし、進める操作を目立たせる */
const variantOf = (kind: SessionOperation["kind"]) => {
  switch (kind) {
    case "Pause":
    case "Resume":
    case "RestartFocus":
    case "SkipBreak":
      return "default";
    case "Abort":
      return "secondary";
    case "End":
      return "outline";
  }
};

const endedMessageOf = (state: Ended): string =>
  state.endedBy === "AutoEnd"
    ? "記入も操作もないまま時間が過ぎたので、セッションを自動終了しました"
    : "セッションを終了しました";

const InSession = ({ state }: Readonly<{ state: Exclude<TimerState, Ended> }>) => (
  <div className="flex flex-col items-center gap-1">
    <p className="text-sm text-muted-foreground">{positionOf(state)}</p>
    <h2 className="text-2xl font-semibold">{phaseLabelOf(state)}</h2>
    {state.kind === "Idle" ? (
      <p className="py-4 text-sm text-muted-foreground">
        集中を再開始すると、{state.setNumber}セット目の集中をやり直します
      </p>
    ) : (
      <>
        <p
          role="timer"
          aria-label="残り時間"
          className="text-7xl font-bold tracking-tight tabular-nums"
        >
          {formatCountdown(state.remainingSeconds)}
        </p>
        {state.clock.kind === "Paused" && (
          <p className="text-sm text-muted-foreground">一時停止中</p>
        )}
      </>
    )}
  </div>
);

const Body = ({
  view,
  pending,
  start,
  operate,
  reload,
}: Readonly<{
  view: TimerView;
  pending: boolean;
  start: () => void;
  operate: (kind: SessionOperation["kind"]) => void;
  reload: () => void;
}>) => {
  switch (view.kind) {
    case "Loading":
      return <p className="text-sm text-muted-foreground">読み込み中…</p>;
    case "LoadFailed":
      return (
        <div className="flex flex-col items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            タイマーを読み込めませんでした
          </p>
          <Button variant="outline" onClick={reload}>
            読み込み直す
          </Button>
        </div>
      );
    case "NoSession":
      return (
        <Button size="lg" onClick={start} disabled={pending}>
          開始
        </Button>
      );
    case "Ended":
      return (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">{endedMessageOf(view.state)}</p>
          <p className="text-sm">完了セット {view.state.completedSets}</p>
          <Button size="lg" onClick={start} disabled={pending}>
            開始
          </Button>
        </div>
      );
    case "InSession":
      return (
        <div className="flex flex-col items-center gap-4">
          <InSession state={view.state} />
          <div className="flex flex-wrap justify-center gap-2">
            {view.operations.map((kind) => (
              <Button
                key={kind}
                variant={variantOf(kind)}
                onClick={() => operate(kind)}
                disabled={pending}
              >
                {operationLabelOf(kind)}
              </Button>
            ))}
          </div>
        </div>
      );
  }
};

/**
 * 画面上部のタイマー（docs/PRODUCT.md「画面」）。カウントダウン、フェーズ、何ラウンド目・何セット目か、
 * その状態でできる操作のボタンを出す。状態の計算と判断は `useSessionTimer` とドメインにある。
 */
export const TimerPanel = () => {
  const { view, pending, errorMessage, start, operate, reload } = useSessionTimer();
  // セッション中（待機・一時停止を含む）は画面を消灯させない
  useWakeLock(view.kind === "InSession");

  return (
    <section aria-label="タイマー" className="flex flex-col items-center gap-3">
      <Body view={view} pending={pending} start={start} operate={operate} reload={reload} />
      {errorMessage !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}
    </section>
  );
};
