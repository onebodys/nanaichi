import { useEffect, useRef, useState } from "react";
import type { JournalEntry, JournalEntryId, WrittenDuring } from "../domain/journal-entry.ts";
import type { TagName } from "../domain/tag.ts";
import type { TimelineDay, TimelineDaySession } from "../domain/timeline.ts";
import { Button } from "./components/ui/button.tsx";
import {
  completedSetsLabelOf,
  dateLabelOf,
  timeLabelOf,
  writtenDuringBadgeOf,
  writtenDuringLabelOf,
} from "./journal-text.ts";
import { cn } from "./lib/utils.ts";
import { linkify } from "./linkify.ts";
import { isSubmitKey } from "./submit-key.ts";
import { TagInput, TagList } from "./tag-input.tsx";
import { useSubmitKey } from "./use-submit-key.ts";
import type { TimelineState } from "./use-timeline.ts";

/** 本文をプレーンテキストで出し、URL だけをリンクにする。改行はそのまま出す */
const EntryBody = ({ text }: Readonly<{ text: string }>) => (
  <p className="text-[15px] leading-[1.7] break-words whitespace-pre-wrap">
    {linkify(text).map((segment, i) =>
      segment.kind === "Link" ? (
        <a
          key={i}
          href={segment.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {segment.href}
        </a>
      ) : (
        <span key={i}>{segment.text}</span>
      ),
    )}
  </p>
);

/** バッジの色（index.css のフェーズの色）。Tailwind が拾えるよう、クラス名は省略せずに書く */
const BADGE_TONES = {
  Focus: "bg-focus-soft text-focus",
  Journal: "bg-journal-soft text-journal",
  Break: "bg-break-soft text-break",
  Idle: "bg-muted text-muted-foreground",
} as const satisfies Record<WrittenDuring["kind"], string>;

/**
 * 書いたときのタイマーの状態のバッジ。見た目は短く（`2-1 ジャーナル`）、読み上げには長い文言を使う
 */
const WrittenDuringBadge = ({ writtenDuring }: Readonly<{ writtenDuring: WrittenDuring }>) => (
  <span
    className={cn(
      "rounded-full px-2 py-0.5 text-[11px] font-semibold",
      BADGE_TONES[writtenDuring.kind],
    )}
  >
    <span className="sr-only">{writtenDuringLabelOf(writtenDuring)}</span>
    <span aria-hidden>{writtenDuringBadgeOf(writtenDuring)}</span>
  </span>
);

/** 編集中・削除の確認中か */
type EntryMode = "Viewing" | "Editing" | "ConfirmingDelete";

const EntryEditor = ({
  initial,
  knownTags,
  save,
  cancel,
}: Readonly<{
  initial: JournalEntry;
  knownTags: ReadonlyArray<TagName>;
  save: (body: string, tags: ReadonlyArray<TagName>) => void;
  cancel: () => void;
}>) => {
  const [draft, setDraft] = useState(initial.body.unwrap());
  const [tags, setTags] = useState(initial.tags);
  const [submitKey] = useSubmitKey();
  const canSave = draft.trim().length > 0;
  return (
    <div className="flex flex-col gap-2">
      <TagInput known={knownTags} attached={tags} onChange={setTags} label="記入のタグを編集" />
      <textarea
        aria-label="記入を編集"
        // 編集を始めたらすぐ書き直せるよう、カーソルを置く
        autoFocus
        className="min-h-16 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (isSubmitKey(submitKey, event)) {
            event.preventDefault();
            if (canSave) save(draft, tags);
          }
          if (event.key === "Escape") {
            cancel();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="xs" onClick={cancel}>
          やめる
        </Button>
        <Button size="xs" onClick={() => save(draft, tags)} disabled={!canSave}>
          保存
        </Button>
      </div>
    </div>
  );
};

const EntryItem = ({
  entry,
  knownTags,
  edit,
  remove,
}: Readonly<{
  entry: JournalEntry;
  knownTags: ReadonlyArray<TagName>;
  edit: TimelineState["edit"];
  remove: (id: JournalEntryId) => Promise<void>;
}>) => {
  const [mode, setMode] = useState<EntryMode>("Viewing");
  const body = entry.body.unwrap();

  return (
    <li aria-label="ジャーナル記入" className="flex flex-col gap-1.5 py-3.5">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <time dateTime={entry.writtenAt.toISOString()}>{timeLabelOf(entry.writtenAt)}</time>
        <WrittenDuringBadge writtenDuring={entry.writtenDuring} />
        {entry.updatedAt.getTime() !== entry.writtenAt.getTime() && <span>編集済み</span>}
      </p>
      {mode === "Editing" ? (
        <EntryEditor
          initial={entry}
          knownTags={knownTags}
          cancel={() => setMode("Viewing")}
          save={(draft, tags) => {
            void edit(entry.id, draft, tags).then((saved) => saved && setMode("Viewing"));
          }}
        />
      ) : (
        <>
          <EntryBody text={body} />
          <TagList tags={entry.tags} />
        </>
      )}
      {mode === "Viewing" && (
        <div className="-ml-2 flex gap-1">
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => setMode("Editing")}
          >
            編集
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => setMode("ConfirmingDelete")}
          >
            削除
          </Button>
        </div>
      )}
      {mode === "ConfirmingDelete" && (
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">この記入を削除しますか？</p>
          <Button variant="destructive" size="xs" onClick={() => void remove(entry.id)}>
            削除する
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setMode("Viewing")}>
            やめる
          </Button>
        </div>
      )}
    </li>
  );
};

const DaySession = ({
  daySession,
  knownTags,
  edit,
  remove,
}: Readonly<{
  daySession: TimelineDaySession;
  knownTags: ReadonlyArray<TagName>;
  edit: TimelineState["edit"];
  remove: TimelineState["remove"];
}>) => (
  <section aria-label={`${timeLabelOf(daySession.startedAt)} からのセッション`}>
    <h4 className="py-2 text-xs text-muted-foreground">
      {timeLabelOf(daySession.startedAt)} からのセッション
    </h4>
    {daySession.entries.length === 0 ? (
      <p className="border-t py-3 text-xs text-muted-foreground">記入はありません</p>
    ) : (
      <ul className="divide-y border-t">
        {daySession.entries.map((entry) => (
          <EntryItem
            key={entry.id}
            entry={entry}
            knownTags={knownTags}
            edit={edit}
            remove={remove}
          />
        ))}
      </ul>
    )}
  </section>
);

const Day = ({
  day,
  knownTags,
  edit,
  remove,
}: Readonly<{
  day: TimelineDay;
  knownTags: ReadonlyArray<TagName>;
  edit: TimelineState["edit"];
  remove: TimelineState["remove"];
}>) => (
  <section aria-label={dateLabelOf(day.date)} className="flex flex-col gap-2">
    <h3 className="flex items-baseline justify-between gap-2">
      <span className="font-bold">{dateLabelOf(day.date)}</span>
      <span className="text-xs text-muted-foreground">
        {completedSetsLabelOf(day.completedSets)}
      </span>
    </h3>
    {day.sessions.map((daySession) => (
      <DaySession
        key={daySession.sessionId}
        daySession={daySession}
        knownTags={knownTags}
        edit={edit}
        remove={remove}
      />
    ))}
  </section>
);

/** 画面に入ったら古いページを読み込む（スクロールで過去にさかのぼれる、docs/PRODUCT.md） */
const LoadMore = ({ loadMore, loading }: Readonly<{ loadMore: () => void; loading: boolean }>) => {
  const ref = useRef<HTMLButtonElement>(null);
  // 画面は時刻とともに描き直されて `loadMore` も作り直されるので、見張りは張り直さず最新のものを呼ぶ
  const latestLoadMore = useRef(loadMore);
  useEffect(() => {
    latestLoadMore.current = loadMore;
  });
  useEffect(() => {
    const target = ref.current;
    if (target === null || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        latestLoadMore.current();
      }
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return (
    <Button ref={ref} variant="outline" onClick={loadMore} disabled={loading}>
      {loading ? "読み込み中…" : "さらに読み込む"}
    </Button>
  );
};

/**
 * 画面下部のタイムライン（docs/PRODUCT.md「画面」）。新しい記入が上で、日付とセッションの区切りを挟む。
 * 組み立てはドメイン（`Timeline.build`）にあり、ここは描画と操作の受け渡しだけをする。
 */
export const TimelinePanel = ({
  timeline,
  knownTags,
}: Readonly<{
  timeline: TimelineState;
  /** 使っているタグ（記入を編集するときの候補） */
  knownTags: ReadonlyArray<TagName>;
}>) => {
  const { view, loadingMore, edit, remove, loadMore, reload } = timeline;

  return (
    <section aria-label="タイムライン" className="flex flex-col gap-8">
      {view.kind === "Loading" && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {view.kind === "LoadFailed" && (
        <div className="flex flex-col items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            タイムラインを読み込めませんでした
          </p>
          <Button variant="outline" onClick={reload}>
            読み込み直す
          </Button>
        </div>
      )}
      {view.kind === "Loaded" && (
        <>
          {view.days.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">
              セッションを開始すると、ここにジャーナル記入が並びます
            </p>
          )}
          {view.days.map((day) => (
            <Day key={day.date.key} day={day} knownTags={knownTags} edit={edit} remove={remove} />
          ))}
          {view.hasMore && <LoadMore loadMore={loadMore} loading={loadingMore} />}
        </>
      )}
    </section>
  );
};
