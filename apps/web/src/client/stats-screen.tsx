import type { ReactNode } from "react";
import {
  STATS_PERIODS,
  type CalendarDay,
  type MonthCount,
  type StatsActivity,
  type StatsPeriod,
  type StatsReport,
  type StatsTrend,
  type TagCount,
} from "../domain/stats.ts";
import { Button } from "./components/ui/button.tsx";
import { cn } from "@/client/lib/utils";
import type { TagName } from "../domain/tag.ts";
import { dateLabelOf, weekdayLabelOf } from "./journal-text.ts";
import { JournalLookup } from "./journal-lookup.tsx";
import { OverlayScreen } from "./overlay-screen.tsx";
import { Segmented } from "./segmented.tsx";
import {
  comparisonLabelOf,
  completionRateLabelOf,
  entryRateLabelOf,
  focusTimeOfSetsLabel,
  heatLevelOf,
  peakHourLabelOf,
  noActivityTitleOf,
  periodLabelOf,
  rangeLabelOf,
} from "./stats-text.ts";
import type { StatsView } from "./use-stats.ts";
import type { TimerView } from "./use-session-timer.ts";

type Active = Extract<StatsActivity, { kind: "Active" }>;

const Card = ({
  title,
  note,
  className,
  children,
}: Readonly<{
  title: string;
  note?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}>) => (
  <section
    className={cn("flex min-w-0 flex-col gap-4 rounded-[14px] border bg-card p-5", className)}
  >
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {note !== undefined && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
    {children}
  </section>
);

/** 見出しの数字1つと、その補足 */
const Kpi = ({
  label,
  value,
  sub,
}: Readonly<{ label: string; value: string; sub?: string | undefined }>) => (
  <div className="flex min-w-0 flex-col rounded-[14px] border bg-card p-4 lg:p-5">
    <span className="text-[13px] text-muted-foreground">{label}</span>
    <span className="mt-1.5 font-mono text-2xl tracking-tight lg:text-[32px]">{value}</span>
    {sub !== undefined && <span className="mt-1 text-xs text-muted-foreground">{sub}</span>}
  </div>
);

const Kpis = ({ report }: Readonly<{ report: StatsReport }>) => {
  const { activity, streak } = report;
  const streakKpi = (
    <Kpi
      label="続けている日数"
      value={`${streak.current}日`}
      sub={streak.longest > 0 ? `最長 ${streak.longest}日` : undefined}
    />
  );
  if (activity.kind === "NoActivity") {
    return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">{streakKpi}</div>;
  }
  const comparison = comparisonLabelOf(report.period, activity);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
      <Kpi
        label="集中した時間"
        value={focusTimeOfSetsLabel(activity.completedSets)}
        sub={[`${activity.completedSets}セット`, comparison].filter(Boolean).join(" · ")}
      />
      <Kpi
        label="セットの完了率"
        value={completionRateLabelOf(activity)}
        sub={`不成立 ${activity.abortedSets}セット`}
      />
      <Kpi
        label="ジャーナル記入"
        value={`${activity.entries}`}
        sub={`記入率 ${entryRateLabelOf(activity)}`}
      />
      {streakKpi}
    </div>
  );
};

/** 縦棒。`ratio` は最も多いものに対する割合 */
const Bar = ({
  ratio,
  highlight,
  title,
}: Readonly<{ ratio: number; highlight: boolean; title: string }>) => (
  <div
    title={title}
    className={cn(
      "w-full max-w-11 rounded-t-md",
      highlight ? "bg-focus-mark" : "bg-focus-mark/30",
      ratio === 0 && "bg-muted",
    )}
    style={{ height: `${Math.max(ratio * 100, 2)}%` }}
  />
);

const DaysChart = ({
  days,
  today,
  dense,
}: Readonly<{ days: ReadonlyArray<CalendarDay>; today: string; dense: boolean }>) => {
  const max = Math.max(1, ...days.map((day) => (day.kind === "Day" ? day.completedSets : 0)));
  const labelOf = (day: CalendarDay) => {
    if (!dense) {
      return weekdayLabelOf(day.date);
    }
    // 月はすべての日に出すと詰まるので、1日と7日おきに出す
    return day.date.day === 1 || day.date.day % 7 === 1 ? `${day.date.day}` : "";
  };
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={days
          .filter((day) => day.kind === "Day")
          .map(
            (day) =>
              `${dateLabelOf(day.date)} ${day.kind === "Day" ? focusTimeOfSetsLabel(day.completedSets) : ""}`,
          )
          .join("、")}
        className={cn(
          "grid h-48 items-end border-b px-1",
          dense ? "gap-[3px]" : "gap-3 lg:gap-[18px]",
        )}
        style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
      >
        {days.map((day) => (
          <div key={day.date.key} className="flex h-full flex-col items-center justify-end gap-1.5">
            {day.kind === "Day" && !dense && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {day.completedSets === 0 ? "" : focusTimeOfSetsLabel(day.completedSets)}
              </span>
            )}
            {day.kind === "Day" ? (
              <Bar
                ratio={day.completedSets / max}
                highlight={day.date.key === today}
                title={`${dateLabelOf(day.date)} ${focusTimeOfSetsLabel(day.completedSets)}`}
              />
            ) : (
              <div className="h-0.5 w-full max-w-11 rounded-full bg-muted/60" />
            )}
          </div>
        ))}
      </div>
      <div
        aria-hidden
        className={cn("grid px-1", dense ? "gap-[3px]" : "gap-3 lg:gap-[18px]")}
        style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
      >
        {days.map((day) => (
          <span
            key={day.date.key}
            className={cn(
              "text-center text-xs text-muted-foreground",
              day.date.key === today && "font-semibold text-foreground",
            )}
          >
            {labelOf(day)}
          </span>
        ))}
      </div>
    </div>
  );
};

const MonthsChart = ({ months }: Readonly<{ months: ReadonlyArray<MonthCount> }>) => {
  const max = Math.max(1, ...months.map((month) => month.completedSets));
  // 長くなりすぎないよう、直近の12か月まで
  const shown = months.slice(-12);
  const labelOf = (month: MonthCount) => `${month.month}月`;
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={shown
          .map((month) => `${labelOf(month)} ${focusTimeOfSetsLabel(month.completedSets)}`)
          .join("、")}
        className="grid h-48 items-end gap-3 border-b px-1"
        style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}
      >
        {shown.map((month, i) => (
          <div
            key={`${month.year}-${month.month}`}
            className="flex h-full flex-col items-center justify-end gap-1.5"
          >
            <span className="font-mono text-[11px] text-muted-foreground">
              {month.completedSets === 0 ? "" : focusTimeOfSetsLabel(month.completedSets)}
            </span>
            <Bar
              ratio={month.completedSets / max}
              highlight={i === shown.length - 1}
              title={`${month.year}年${labelOf(month)} ${focusTimeOfSetsLabel(month.completedSets)}`}
            />
          </div>
        ))}
      </div>
      <div
        aria-hidden
        className="grid gap-3 px-1"
        style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}
      >
        {shown.map((month) => (
          <span
            key={`${month.year}-${month.month}`}
            className="text-center text-xs text-muted-foreground"
          >
            {labelOf(month)}
          </span>
        ))}
      </div>
    </div>
  );
};

const TrendCard = ({ trend, today }: Readonly<{ trend: StatsTrend; today: string }>) => {
  switch (trend.kind) {
    case "None":
      return null;
    case "Days":
      return (
        <Card title="日ごとの集中" note="完了セット × 7分" className="lg:col-span-3">
          <DaysChart days={trend.days} today={today} dense={trend.days.length > 7} />
        </Card>
      );
    case "Months":
      return (
        <Card title="月ごとの集中" note="完了セット × 7分" className="lg:col-span-3">
          <MonthsChart months={trend.months} />
        </Card>
      );
  }
};

const TagsCard = ({ tags, wide }: Readonly<{ tags: ReadonlyArray<TagCount>; wide: boolean }>) => {
  const max = Math.max(1, ...tags.map((tag) => tag.completedSets));
  return (
    <Card title="よく使ったタグ" className={wide ? "lg:col-span-5" : "lg:col-span-2"}>
      {tags.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          この期間に、タグのついた記入はありません。入力欄の上でタグをつけると、ここに出ます。
        </p>
      ) : (
        <ul className="flex flex-col gap-3.5">
          {tags.map((tag) => (
            <li key={tag.name} className="flex flex-col gap-1.5">
              <div className="flex justify-between gap-3 text-[13px]">
                <span className="truncate">#{tag.name}</span>
                <span className="shrink-0 text-muted-foreground">{tag.completedSets}セット</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted">
                <div
                  className="h-1.5 rounded-full bg-focus-mark"
                  style={{ width: `${(tag.completedSets / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-auto text-xs text-muted-foreground">
        タグのついた記入があった完了セットを数えます
      </p>
    </Card>
  );
};

const HEAT_CLASSES = [
  "bg-muted",
  "bg-focus-mark/20",
  "bg-focus-mark/45",
  "bg-focus-mark/70",
  "bg-focus-mark",
] as const;

const CalendarCard = ({
  calendar,
  wide = false,
}: Readonly<{ calendar: ReadonlyArray<CalendarDay>; wide?: boolean }>) => (
  <Card title="この12週間" note="1マス = 1日" className={wide ? "lg:col-span-5" : "lg:col-span-3"}>
    <div>
      <div
        role="img"
        aria-label={`この12週間で完了セットのあった日は${
          calendar.filter((day) => day.kind === "Day" && day.completedSets > 0).length
        }日`}
        className="grid max-w-[330px] auto-cols-fr grid-flow-col grid-rows-7 gap-1"
      >
        {calendar.map((day) => (
          <span
            key={day.date.key}
            title={
              day.kind === "Day"
                ? `${dateLabelOf(day.date)} ${focusTimeOfSetsLabel(day.completedSets)}`
                : undefined
            }
            className={cn(
              "aspect-square w-full rounded-[3px]",
              day.kind === "Day"
                ? HEAT_CLASSES[heatLevelOf(day.completedSets)]
                : "border border-dashed border-border",
            )}
          />
        ))}
      </div>
    </div>
    <div aria-hidden className="flex items-center gap-1.5 text-xs text-muted-foreground">
      少ない
      {HEAT_CLASSES.map((className) => (
        <span key={className} className={cn("size-3.5 rounded-[3px]", className)} />
      ))}
      多い
    </div>
  </Card>
);

const HOUR_LABELS = [0, 6, 12, 18, 23] as const;

const HoursCard = ({ hours }: Readonly<{ hours: ReadonlyArray<number> }>) => {
  const max = Math.max(1, ...hours);
  const peak = peakHourLabelOf(hours);
  const peakIndex = hours.indexOf(Math.max(...hours));
  return (
    <Card title="集中した時間帯" className="lg:col-span-2">
      <div
        role="img"
        aria-label={hours
          .map((count, hour) => (count === 0 ? "" : `${hour}時台 ${count}セット`))
          .filter(Boolean)
          .join("、")}
        className="grid h-28 items-end gap-[3px]"
        style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}
      >
        {hours.map((count, hour) => (
          <div
            key={hour}
            title={`${hour}時台 ${count}セット`}
            className={cn(
              "rounded-t-[3px]",
              count === 0 ? "bg-muted" : hour === peakIndex ? "bg-focus-mark" : "bg-focus-mark/30",
            )}
            style={{ height: `${Math.max((count / max) * 100, 3)}%` }}
          />
        ))}
      </div>
      <div aria-hidden className="flex justify-between text-[11px] text-muted-foreground">
        {HOUR_LABELS.map((hour) => (
          <span key={hour}>{hour}時</span>
        ))}
      </div>
      {peak !== undefined && (
        <p className="text-[13px]">
          いちばん集中できているのは <b>{peak}</b>
        </p>
      )}
    </Card>
  );
};

/** 期間の中に記録がないときの案内 */
const NoActivity = ({ period, close }: Readonly<{ period: StatsPeriod; close: () => void }>) => (
  <section className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed bg-card px-6 py-10 text-center lg:col-span-5">
    <h2 className="text-base font-semibold">{noActivityTitleOf(period)}</h2>
    <p className="max-w-md text-sm text-muted-foreground">
      集中を最後まで終えると、集中した時間やジャーナル記入がここに積み上がります。
    </p>
    <Button className="mt-2" onClick={close}>
      タイマーに戻る
    </Button>
  </section>
);

const Charts = ({ report, activity }: Readonly<{ report: StatsReport; activity: Active }>) => {
  const hasTrend = activity.trend.kind !== "None";
  return (
    <>
      <TrendCard trend={activity.trend} today={report.today.key} />
      <TagsCard tags={activity.tags} wide={!hasTrend} />
      <CalendarCard calendar={report.calendar} />
      <HoursCard hours={activity.hours} />
    </>
  );
};

const Report = ({ report, close }: Readonly<{ report: StatsReport; close: () => void }>) => (
  <>
    <Kpis report={report} />
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-5 lg:gap-4">
      {report.activity.kind === "Active" ? (
        <Charts report={report} activity={report.activity} />
      ) : (
        <>
          <NoActivity period={report.period} close={close} />
          <CalendarCard calendar={report.calendar} wide />
        </>
      )}
    </div>
  </>
);

/**
 * スタッツ（GLOSSARY、Issue #35）。ホーム画面の上に重ねて出し、開いている間もタイマーと知らせは進む
 * （`OverlayScreen`）。数えるのはサーバーで（ADR 0014）、ここは受け取った値を描くだけ
 */
export const StatsScreen = ({
  timer,
  stats,
  period,
  changePeriod,
  knownTags,
  close,
}: Readonly<{
  timer: TimerView;
  stats: StatsView;
  period: StatsPeriod;
  changePeriod: (period: StatsPeriod) => void;
  /** 使っているタグ（記入をタグで見返すときに選ぶ） */
  knownTags: ReadonlyArray<TagName>;
  close: () => void;
}>) => (
  <OverlayScreen labelledBy="stats-title" timer={timer} close={close}>
    <div className="mx-auto flex max-w-[1080px] flex-col gap-5 px-4 py-6 lg:gap-6 lg:px-8 lg:py-9">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 id="stats-title" className="text-[22px] font-bold lg:text-2xl">
            スタッツ
          </h1>
          <p className="mt-1.5 min-h-5 text-sm text-muted-foreground">
            {stats.kind === "Loaded" ? rangeLabelOf(stats.report) : ""}
          </p>
        </div>
        <Segmented
          name="stats-period"
          legend="期間"
          options={STATS_PERIODS.map((value) => ({ value, label: periodLabelOf(value) }))}
          value={period}
          onChange={changePeriod}
        />
      </div>
      {stats.kind === "Loaded" && <Report report={stats.report} close={close} />}
      {stats.kind === "Loading" && (
        <p className="py-10 text-center text-sm text-muted-foreground">読み込み中…</p>
      )}
      {stats.kind === "LoadFailed" && (
        <p role="alert" className="py-10 text-center text-sm text-destructive">
          スタッツを読み込めませんでした。通信できる状態で開き直してください。
        </p>
      )}
      {/* ジャーナル記入の見返しは期間に関わらないので、スタッツを読み込めなくても出す */}
      <Card title="ジャーナル記入を見返す" note="期間に関わらず">
        <JournalLookup knownTags={knownTags} />
      </Card>
    </div>
  </OverlayScreen>
);
