import { useState, type ReactNode } from "react";
import {
  JournalCalendar,
  type JournalCalendarDay,
  type JournalMonth,
} from "../domain/journal-calendar.ts";
import { Calendar, localDateIn, type LocalDate } from "../domain/local-date.ts";
import type { TagName } from "../domain/tag.ts";
import { TaggedEntries } from "../domain/tagged-entries.ts";
import { Button } from "./components/ui/button.tsx";
import { ReadOnlyEntry } from "./entry-parts.tsx";
import {
  calendarDayLabelOf,
  dateLabelOf,
  entryCountLabelOf,
  monthLabelOf,
} from "./journal-text.ts";
import { cn } from "./lib/utils.ts";
import { Segmented } from "./segmented.tsx";
import {
  useEntriesOnDate,
  useJournalCalendar,
  useTaggedEntries,
  type LoadView,
} from "./use-journal-lookup.ts";
import { deviceTimeZone } from "./use-stats.ts";

const LOOKUP_BY = ["Date", "Tag"] as const;
type LookupBy = (typeof LOOKUP_BY)[number];

const LOOKUP_LABELS = { Date: "日付で", Tag: "タグで" } as const satisfies Record<LookupBy, string>;

const WEEKDAY_HEADERS = ["月", "火", "水", "木", "金", "土", "日"] as const;

/** 読み込み中・読み込めなかったときの表示。読み込めたら `children` に値を渡す */
const Loaded = <T,>({
  view,
  what,
  reload,
  children,
}: Readonly<{
  view: LoadView<T>;
  what: string;
  reload: () => void;
  children: (value: T) => ReactNode;
}>) => {
  switch (view.kind) {
    case "Loading":
      return <p className="py-6 text-center text-sm text-muted-foreground">読み込み中…</p>;
    case "LoadFailed":
      return (
        <div className="flex flex-col items-center gap-3 py-6">
          <p role="alert" className="text-sm text-destructive">
            {what}を読み込めませんでした
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            読み込み直す
          </Button>
        </div>
      );
    case "Loaded":
      return children(view.value);
  }
};

const CalendarDayButton = ({
  day,
  today,
  selected,
  select,
}: Readonly<{
  day: JournalCalendarDay;
  today: string;
  selected: boolean;
  select: (date: LocalDate) => void;
}>) => {
  switch (day.kind) {
    case "Upcoming":
      return (
        <span
          aria-hidden
          className="flex aspect-square items-center justify-center rounded-lg text-[13px] text-muted-foreground/50"
        >
          {day.date.day}
        </span>
      );
    case "Day":
      return (
        <button
          type="button"
          aria-pressed={selected}
          aria-label={calendarDayLabelOf(day.date, day.entries)}
          onClick={() => select(day.date)}
          className={cn(
            "relative flex aspect-square flex-col items-center justify-center rounded-lg text-[13px] hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            day.entries > 0 && "bg-focus-mark/15",
            day.date.key === today && "font-bold text-foreground",
            selected && "bg-foreground text-background hover:bg-foreground",
          )}
        >
          {day.date.day}
          {day.entries > 0 && (
            <span
              aria-hidden
              className={cn(
                "text-[10px] leading-none",
                selected ? "text-background/80" : "text-muted-foreground",
              )}
            >
              {day.entries}
            </span>
          )}
        </button>
      );
  }
};

/** ジャーナルのカレンダー（GLOSSARY）。月曜始まりの週に並べ、記入のある日に数を出す */
const MonthCalendar = ({
  month,
  changeMonth,
  thisMonth,
  selected,
  select,
}: Readonly<{
  month: JournalMonth;
  changeMonth: (month: JournalMonth) => void;
  thisMonth: JournalMonth;
  selected: LocalDate;
  select: (date: LocalDate) => void;
}>) => {
  const { view, reload } = useJournalCalendar(month);
  const isThisMonth = month.year === thisMonth.year && month.month === thisMonth.month;
  const leading = Calendar.weekdayOf(Calendar.firstOfMonth(month.year, month.month));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          aria-label="前の月"
          onClick={() => changeMonth(JournalCalendar.monthBefore(month))}
        >
          ‹
        </Button>
        <h3 aria-live="polite" className="text-sm font-semibold">
          {monthLabelOf(month)}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          aria-label="次の月"
          disabled={isThisMonth}
          onClick={() => changeMonth(JournalCalendar.monthAfter(month))}
        >
          ›
        </Button>
      </div>
      <div aria-hidden className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
        {WEEKDAY_HEADERS.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <Loaded view={view} what="カレンダー" reload={reload}>
        {(calendar) => (
          <div role="group" aria-label={monthLabelOf(month)} className="grid grid-cols-7 gap-1">
            {Array.from({ length: leading }, (_, i) => (
              <span key={`blank-${i}`} aria-hidden />
            ))}
            {calendar.days.map((day) => (
              <CalendarDayButton
                key={day.date.key}
                day={day}
                today={calendar.today.key}
                selected={day.date.key === selected.key}
                select={select}
              />
            ))}
          </div>
        )}
      </Loaded>
    </div>
  );
};

/** 選んだ日の記入。書いた順 */
const EntriesOnDate = ({ date }: Readonly<{ date: LocalDate }>) => {
  const { view, reload } = useEntriesOnDate(date);
  return (
    <section aria-label={`${dateLabelOf(date)}の記入`} className="flex min-w-0 flex-col gap-1">
      <h3 className="flex items-baseline justify-between gap-2">
        <span className="font-bold">{dateLabelOf(date)}</span>
        {view.kind === "Loaded" && (
          <span className="text-xs text-muted-foreground">
            {entryCountLabelOf(view.value.entries.length)}
          </span>
        )}
      </h3>
      <Loaded view={view} what="記入" reload={reload}>
        {({ entries }) =>
          entries.length === 0 ? (
            <p className="border-t py-6 text-sm text-muted-foreground">この日の記入はありません</p>
          ) : (
            <ul className="divide-y border-t">
              {entries.map((entry) => (
                <ReadOnlyEntry key={entry.id} entry={entry} />
              ))}
            </ul>
          )
        }
      </Loaded>
    </section>
  );
};

const ByDate = () => {
  // 開いたときは今日を選ぶ。日付は端末のタイムゾーンで区切る
  const [today] = useState(() => localDateIn(deviceTimeZone())(new Date()));
  const thisMonth = { year: today.year, month: today.month };
  const [month, setMonth] = useState<JournalMonth>(thisMonth);
  const [selected, setSelected] = useState<LocalDate>(today);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-8">
      <MonthCalendar
        month={month}
        changeMonth={setMonth}
        thisMonth={thisMonth}
        selected={selected}
        select={setSelected}
      />
      <EntriesOnDate date={selected} />
    </div>
  );
};

/** タグのついた記入。新しい順に、書いた日付で区切る */
const TaggedEntryList = ({ tag }: Readonly<{ tag: TagName }>) => {
  const { view, loadingMore, loadMore, reload } = useTaggedEntries(tag);
  return (
    <section aria-label={`#${tag} の記入`} className="flex min-w-0 flex-col gap-6">
      <Loaded view={view} what="記入" reload={reload}>
        {({ entries, next }) => (
          <>
            {entries.length === 0 && (
              <p className="text-sm text-muted-foreground">このタグのついた記入はありません</p>
            )}
            {TaggedEntries.byDate(entries, deviceTimeZone()).map((day) => (
              <section key={day.date.key} aria-label={dateLabelOf(day.date)}>
                <h3 className="pb-1 font-bold">{dateLabelOf(day.date)}</h3>
                <ul className="divide-y border-t">
                  {day.entries.map((entry) => (
                    <ReadOnlyEntry key={entry.id} entry={entry} />
                  ))}
                </ul>
              </section>
            ))}
            {next.kind === "More" && (
              <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "読み込み中…" : "さらに読み込む"}
              </Button>
            )}
          </>
        )}
      </Loaded>
    </section>
  );
};

const ByTag = ({ knownTags }: Readonly<{ knownTags: ReadonlyArray<TagName> }>) => {
  const [selected, setSelected] = useState<TagName | undefined>(undefined);
  if (knownTags.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        タグのついた記入はまだありません。入力欄の上でタグをつけると、ここから見返せます。
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <ul aria-label="タグ" className="flex flex-wrap gap-2">
        {knownTags.map((tag) => (
          <li key={tag}>
            <button
              type="button"
              aria-pressed={tag === selected}
              onClick={() => setSelected(tag)}
              className={cn(
                "rounded-full border px-3 py-1 text-[13px] hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                tag === selected &&
                  "border-foreground bg-foreground text-background hover:bg-foreground",
              )}
            >
              #{tag}
            </button>
          </li>
        ))}
      </ul>
      {selected === undefined ? (
        <p className="text-sm text-muted-foreground">
          タグを選ぶと、そのタグのついた記入が新しい順に並びます
        </p>
      ) : (
        <TaggedEntryList key={selected} tag={selected} />
      )}
    </div>
  );
};

/**
 * スタッツのジャーナル記入の見返し（Issue #83）。ジャーナルのカレンダーで選んだ日の記入か、選んだタグのついた記入を
 * 読むだけで出す（編集・削除はタイムラインで）。スタッツの期間には関わらない
 */
export const JournalLookup = ({
  knownTags,
}: Readonly<{
  /** 使っているタグ（最近使った順） */
  knownTags: ReadonlyArray<TagName>;
}>) => {
  const [by, setBy] = useState<LookupBy>("Date");
  return (
    <div className="flex flex-col gap-5">
      {/* 横いっぱいに伸ばさず、期間の切り替えと同じ幅にする */}
      <div className="self-start">
        <Segmented
          name="journal-lookup-by"
          legend="見返し方"
          options={LOOKUP_BY.map((value) => ({ value, label: LOOKUP_LABELS[value] }))}
          value={by}
          onChange={setBy}
        />
      </div>
      {by === "Date" ? <ByDate /> : <ByTag knownTags={knownTags} />}
    </div>
  );
};
