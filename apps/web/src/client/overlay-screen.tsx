import type { ReactNode } from "react";
import { ChevronLeftIcon } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import { backgroundTimerLabelOf } from "./settings-text.ts";
import type { TimerView } from "./use-session-timer.ts";

/**
 * ホーム画面の上に重ねて出す画面（設定画面・スタッツ）の枠。ホーム画面は閉じないので、
 * タイマー・フェーズの切り替わりの知らせ・Wake Lock・同期は、開いている間も止まらずに進む。
 * 上部に「タイマーに戻る」と、裏で進んでいるタイマーを出す。Escape でも閉じる
 */
export const OverlayScreen = ({
  labelledBy,
  timer,
  close,
  children,
}: Readonly<{ labelledBy: string; timer: TimerView; close: () => void; children: ReactNode }>) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby={labelledBy}
    className="fixed inset-0 z-40 overflow-y-auto bg-background"
    onKeyDown={(event) => {
      // 選択肢（別の場所に描く）の中の Escape は、選択肢を閉じるだけにする
      const inScreen = event.target instanceof Node && event.currentTarget.contains(event.target);
      if (event.key === "Escape" && inScreen) {
        close();
      }
    }}
  >
    <header className="sticky top-0 z-10 border-b bg-card">
      <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center justify-between gap-4 px-2 lg:h-16 lg:px-6">
        <Button variant="ghost" size="lg" autoFocus onClick={close}>
          <ChevronLeftIcon />
          タイマーに戻る
        </Button>
        {timer.kind === "InSession" && (
          <p className="truncate text-xs text-muted-foreground">
            <span className="hidden sm:inline">セッションは裏で進み続けます · </span>
            <span className="font-mono">{backgroundTimerLabelOf(timer.state)}</span>
          </p>
        )}
      </div>
    </header>
    {children}
  </div>
);
