import { useEffect, useRef, useState } from "react";
import type { EntryCount } from "../domain/session-summary.ts";
import { Timeline } from "../domain/timeline.ts";
import { AppHeader } from "./app-header.tsx";
import type { TodayFocus } from "./focus-time-text.ts";
import { JournalInput } from "./journal-input.tsx";
import { createPhaseAlert } from "./phase-alert.ts";
import { SettingsScreen } from "./settings-screen.tsx";
import { TimelinePanel } from "./timeline-panel.tsx";
import { TimerPanel } from "./timer-panel.tsx";
import { useSessionTimer, type TimerView } from "./use-session-timer.ts";
import { useSync } from "./use-sync.ts";
import { useTags } from "./use-tags.ts";
import { useTimeline, type TimelineView } from "./use-timeline.ts";

/** ジャーナルのフェーズにいれば、そのセットを見分ける値。フェーズに入ったことを見分けるのに使う */
const journalPhaseKeyOf = (view: TimerView): string | undefined =>
  view.kind === "InSession" && view.state.kind === "Journal"
    ? `${view.state.round}:${view.state.setNumber}`
    : undefined;

/** ヘッダーに出す今日の完了セット数。タイムラインを読み込むまでは数えられない */
const todayFocusOf = (timeline: TimelineView): TodayFocus =>
  timeline.kind === "Loaded" ? timeline.today : { kind: "Loading" };

/** 終了したセッションの記入の数。タイムラインに重ねたセッションから数える */
const endedEntriesOf = (timer: TimerView, timeline: TimelineView): EntryCount =>
  timer.kind === "Ended" && timeline.kind === "Loaded"
    ? { kind: "Counted", count: Timeline.entryCountOf(timeline.days, timer.session.id) }
    : { kind: "NotYetCounted" };

/**
 * ホーム画面（docs/PRODUCT.md「画面」、Issue #34 の A 案）。
 * PC は左にタイマー、右にジャーナル（入力欄とタイムライン）の2ペインで、右だけがスクロールする。
 * スマホは上にタイマーのカード、その下に入力欄とタイムラインを縦に並べる。
 */
export const HomePage = ({
  settings,
}: Readonly<{
  /** 設定画面を重ねて開いているか。開閉は URL（`?settings=open`）で持ち、ブラウザの戻るで閉じられる */
  settings: Readonly<{ open: boolean; show: () => void; close: () => void }>;
}>) => {
  // タイマー（フェーズの切り替わりで知らせる）と設定（試しに鳴らす）で同じ音の準備を使う
  const [phaseAlert] = useState(createPhaseAlert);
  const timer = useSessionTimer(phaseAlert);
  const tags = useTags();
  const timeline = useTimeline(timer.session, timer.serverNow, () => {
    timer.refresh();
    tags.refresh();
  });
  useSync(timer, timeline, tags);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ジャーナルのフェーズに入ったら、すぐ書けるよう入力欄にカーソルを置く（docs/PRODUCT.md「画面」）。
  // 設定画面を開いている間は置けないので、ジャーナル中に設定画面を閉じたときに置く
  const journalPhaseKey = journalPhaseKeyOf(timer.view);
  const settingsOpen = settings.open;
  useEffect(() => {
    if (journalPhaseKey !== undefined && !settingsOpen) {
      textareaRef.current?.focus();
    }
  }, [journalPhaseKey, settingsOpen]);

  return (
    <>
      {/* 設定画面を開いている間も閉じずに描き、タイマーと知らせを進め続ける。操作と読み上げからは外す */}
      <div className="flex min-h-dvh flex-col lg:h-dvh" inert={settings.open}>
        <AppHeader today={todayFocusOf(timeline.view)} openSettings={settings.show} />
        {/* 4K のような広い画面でも左に寄らないよう、2ペインの幅を抑えて中央に置く。十分に広い画面では左右に線を引いて区切る */}
        <div className="flex flex-1 flex-col gap-4 py-4 lg:mx-auto lg:min-h-0 lg:w-full lg:max-w-[1400px] lg:flex-row lg:gap-0 lg:py-0 min-[1600px]:border-x">
          <TimerPanel
            timer={timer}
            entries={endedEntriesOf(timer.view, timeline.view)}
            className="px-4 lg:w-[44%] lg:max-w-[640px] lg:shrink-0 lg:justify-center lg:border-r lg:px-8 lg:py-12"
          />
          <main className="flex-1 lg:min-h-0 lg:overflow-y-auto">
            <div className="flex max-w-[760px] flex-col gap-6 px-4 lg:gap-7 lg:px-12 lg:py-8">
              <div className="flex flex-col gap-2">
                <JournalInput
                  sessionId={timer.view.kind === "InSession" ? timer.session?.id : undefined}
                  knownTags={tags.known}
                  write={timeline.write}
                  textareaRef={textareaRef}
                  inJournalPhase={journalPhaseKey !== undefined}
                />
                {timeline.errorMessage !== undefined && (
                  <p role="alert" className="text-sm text-destructive">
                    {timeline.errorMessage}
                  </p>
                )}
              </div>
              <TimelinePanel timeline={timeline} knownTags={tags.known} />
            </div>
          </main>
        </div>
      </div>
      {settings.open && (
        <SettingsScreen phaseAlert={phaseAlert} timer={timer.view} close={settings.close} />
      )}
    </>
  );
};
