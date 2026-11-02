import { useEffect, useRef, useState } from "react";
import type { EntryCount } from "../domain/session-summary.ts";
import { Stats, type StatsPeriod } from "../domain/stats.ts";
import { Timeline } from "../domain/timeline.ts";
import { AppHeader } from "./app-header.tsx";
import type { TodayFocus } from "./focus-time-text.ts";
import { JournalInput } from "./journal-input.tsx";
import { createPhaseAlert } from "./phase-alert.ts";
import { SettingsScreen } from "./settings-screen.tsx";
import { statsRefreshKeyOf } from "./stats-refresh.ts";
import { StatsScreen } from "./stats-screen.tsx";
import { TimelinePanel } from "./timeline-panel.tsx";
import { TimerPanel } from "./timer-panel.tsx";
import { useAdvanceMode } from "./use-advance-mode.ts";
import type { AttachedTagsKey } from "./attached-tags.ts";
import { applyTagDeletionToAttached } from "./use-attached-tags.ts";
import { useSessionTimer, type TimerView } from "./use-session-timer.ts";
import { deviceTimeZone, useStats, type StatsView } from "./use-stats.ts";
import { useSync } from "./use-sync.ts";
import { useTagUsage } from "./use-tag-usage.ts";
import { useTags } from "./use-tags.ts";
import { useTimeline, type TimelineState, type TimelineView } from "./use-timeline.ts";

/** ジャーナルのフェーズにいれば、そのセットを見分ける値。フェーズに入ったことを見分けるのに使う */
const journalPhaseKeyOf = (view: TimerView): string | undefined =>
  view.kind === "InSession" && view.state.kind === "Journal"
    ? `${view.state.round}:${view.state.setNumber}`
    : undefined;

/**
 * ヘッダーに出す今日の完了セット数。スタッツ（期間は今日）で数えた値を出す（ADR 0014）。
 * スタッツを読み込めるまでは、タイムラインで数えた値を出す
 */
const todayFocusOf = (today: StatsView, timeline: TimelineView): TodayFocus => {
  if (today.kind === "Loaded") {
    return { kind: "Counted", count: Stats.completedSetsOf(today.report) };
  }
  return timeline.kind === "Loaded" ? timeline.today : { kind: "Loading" };
};

/**
 * タイムラインの今日の区切りに、スタッツで数えた今日の完了セット数を入れる。1日にセッションが多く、
 * 今日の区切りの数がタイムラインだけでは確定しないとき（ADR 0011）に使われる
 */
const withTodayCounted = (timeline: TimelineState, today: StatsView): TimelineState =>
  timeline.view.kind === "Loaded" && today.kind === "Loaded"
    ? {
        ...timeline,
        view: {
          ...timeline.view,
          days: Timeline.withDayCounted(
            timeline.view.days,
            today.report.today.key,
            Stats.completedSetsOf(today.report),
          ),
        },
      }
    : timeline;

/** 終了したセッションの記入の数。タイムラインに重ねたセッションから数える */
const endedEntriesOf = (timer: TimerView, timeline: TimelineView): EntryCount =>
  timer.kind === "Ended" && timeline.kind === "Loaded"
    ? { kind: "Counted", count: Timeline.entryCountOf(timeline.days, timer.session.id) }
    : { kind: "NotYetCounted" };

/**
 * ホーム画面（docs/PRODUCT.md「画面」、Issue #34 の A 案）。
 * PC は左にタイマー、右にジャーナル（入力欄とタイムライン）の2ペインで、右のタイムラインだけがスクロールする（入力欄は上に固定）。
 * スマホは上にタイマーのカード、その下に入力欄とタイムラインを縦に並べる。
 */
export const HomePage = ({
  attachedTagsKey,
  settings,
  stats,
}: Readonly<{
  /** つけたままのタグを覚えるキー。記録先ごとに分ける（attached-tags.ts） */
  attachedTagsKey: AttachedTagsKey;
  /** 設定画面を重ねて開いているか。開閉は URL（`?settings=open`）で持ち、ブラウザの戻るで閉じられる */
  settings: Readonly<{ open: boolean; show: () => void; close: () => void }>;
  /** スタッツを重ねて開いているなら、その期間（`?stats=<期間>`）。開いていなければ `undefined` */
  stats: Readonly<{
    period: StatsPeriod | undefined;
    show: () => void;
    changePeriod: (period: StatsPeriod) => void;
    close: () => void;
  }>;
}>) => {
  // タイマー（フェーズの切り替わりで知らせる）と設定（試しに鳴らす）で同じ音の準備を使う
  const [phaseAlert] = useState(createPhaseAlert);
  const timer = useSessionTimer(phaseAlert);
  const tags = useTags();
  const timeline = useTimeline(timer.session, timer.serverNow, () => {
    timer.refresh();
    tags.refresh();
  });
  // 進め方を変えるとタイマーの状態が変わりうるので、変えたら読み込み直す（他の端末へは同期メッセージで届く）
  const advanceMode = useAdvanceMode(timer.refresh);
  // 削除したタグは、読み込んだ記入とこの端末でつけたままのタグからも外す（ADR 0017）
  const tagUsage = useTagUsage(settings.open, (deleted) => {
    timeline.receiveTagDeletion(deleted);
    applyTagDeletionToAttached(attachedTagsKey, deleted);
    tags.refresh();
  });
  useSync({ timer, timeline, tags, tagUsage, advanceMode, attachedTagsKey });
  // 今日の集中時間（ヘッダー）とスタッツは、完了セットが増えうるときだけ読み込み直す（ADR 0014）
  const statsRefreshKey = statsRefreshKeyOf(timer.view, timer.serverNow, deviceTimeZone());
  const todayStats = useStats("Today", statsRefreshKey);
  const statsPeriod = stats.period ?? "Week";
  const statsView = useStats(statsPeriod, statsRefreshKey, stats.period !== undefined);
  const overlayOpen = settings.open || stats.period !== undefined;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ジャーナルのフェーズに入ったら、すぐ書けるよう入力欄にカーソルを置く（docs/PRODUCT.md「画面」）。
  // 設定画面・スタッツを開いている間は置けないので、ジャーナル中に閉じたときに置く
  const journalPhaseKey = journalPhaseKeyOf(timer.view);
  useEffect(() => {
    if (journalPhaseKey !== undefined && !overlayOpen) {
      textareaRef.current?.focus();
    }
  }, [journalPhaseKey, overlayOpen]);

  return (
    <>
      {/* 設定画面・スタッツを開いている間も閉じずに描き、タイマーと知らせを進め続ける。操作と読み上げからは外す */}
      <div className="flex min-h-dvh flex-col lg:h-dvh" inert={overlayOpen}>
        <AppHeader
          today={todayFocusOf(todayStats, timeline.view)}
          openStats={stats.show}
          openSettings={settings.show}
        />
        {/* 4K のような広い画面でも左に寄らないよう、2ペインの幅を抑えて中央に置く。十分に広い画面では左右に線を引いて区切る */}
        <div className="flex flex-1 flex-col gap-4 py-4 lg:mx-auto lg:min-h-0 lg:w-full lg:max-w-[1400px] lg:flex-row lg:gap-0 lg:py-0 min-[1600px]:border-x">
          <TimerPanel
            timer={timer}
            entries={endedEntriesOf(timer.view, timeline.view)}
            className="px-4 lg:w-[44%] lg:max-w-[640px] lg:shrink-0 lg:justify-center lg:border-r lg:px-8 lg:py-12"
          />
          {/* PC では入力欄を上に固定し、タイムラインだけをスクロールする（Issue #72）。過去を読んでいてもすぐ書ける */}
          <main className="flex flex-1 flex-col gap-6 lg:min-h-0 lg:gap-0">
            <div className="flex max-w-[760px] flex-col gap-2 px-4 lg:shrink-0 lg:px-12 lg:pt-8 lg:pb-5">
              <JournalInput
                attachedTagsKey={attachedTagsKey}
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
            {/*
              スクロールバーが右ペインの右端に出るよう、スクロールする領域は幅いっぱいにとる。
              `relative` がないと、バッジの読み上げ用の文言（`sr-only` は absolute）がこの領域の外に出て、ページ全体までスクロールしてしまう
            */}
            <div className="relative lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:border-t">
              <div className="max-w-[760px] px-4 lg:px-12 lg:pt-6 lg:pb-8">
                <TimelinePanel
                  timeline={withTodayCounted(timeline, todayStats)}
                  knownTags={tags.known}
                />
              </div>
            </div>
          </main>
        </div>
      </div>
      {settings.open && (
        <SettingsScreen
          phaseAlert={phaseAlert}
          advanceMode={advanceMode}
          tagUsage={tagUsage}
          timer={timer.view}
          close={settings.close}
        />
      )}
      {stats.period !== undefined && (
        <StatsScreen
          timer={timer.view}
          stats={statsView}
          period={statsPeriod}
          changePeriod={stats.changePeriod}
          knownTags={tags.known}
          close={stats.close}
        />
      )}
    </>
  );
};
