import { useEffect, useRef } from "react";
import { authClient } from "./auth-client.ts";
import { Button } from "./components/ui/button.tsx";
import { JournalInput } from "./journal-input.tsx";
import { TimelinePanel } from "./timeline-panel.tsx";
import { TimerPanel } from "./timer-panel.tsx";
import { useSessionTimer, type TimerView } from "./use-session-timer.ts";
import { useSync } from "./use-sync.ts";
import { useTimeline } from "./use-timeline.ts";

/** ジャーナルのフェーズにいれば、そのセットを見分ける値。フェーズに入ったことを見分けるのに使う */
const journalPhaseKeyOf = (view: TimerView): string | undefined =>
  view.kind === "InSession" && view.state.kind === "Journal"
    ? `${view.state.round}:${view.state.setNumber}`
    : undefined;

export const HomePage = () => {
  const { data: session, isPending } = authClient.useSession();
  const timer = useSessionTimer();
  const timeline = useTimeline(timer.session, timer.serverNow, timer.refresh);
  useSync(timer, timeline);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ジャーナルのフェーズに入ったら、すぐ書けるよう入力欄にカーソルを置く（docs/PRODUCT.md「画面」）
  const journalPhaseKey = journalPhaseKeyOf(timer.view);
  useEffect(() => {
    if (journalPhaseKey !== undefined) {
      textareaRef.current?.focus();
    }
  }, [journalPhaseKey]);

  const signOut = async () => {
    await authClient.signOut();
    // ログアウト後はセッションが無くなるので、ルートの beforeLoad がログイン画面へ送る
    window.location.href = "/login";
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-10 px-6 py-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-bold tracking-tight">nanaichi</h1>
        {isPending || session === null ? (
          <p className="text-sm text-muted-foreground">読み込み中…</p>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground">
              {session.user.name} としてログインしています
            </p>
            <Button variant="outline" size="sm" onClick={signOut}>
              ログアウト
            </Button>
          </div>
        )}
      </header>

      <TimerPanel timer={timer} />

      <div className="flex flex-col gap-2">
        <JournalInput
          inSession={timer.view.kind === "InSession"}
          write={timeline.write}
          textareaRef={textareaRef}
        />
        {timeline.errorMessage !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {timeline.errorMessage}
          </p>
        )}
      </div>

      <TimelinePanel timeline={timeline} />
    </main>
  );
};
