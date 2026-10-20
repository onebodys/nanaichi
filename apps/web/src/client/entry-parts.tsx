import type { JournalEntry, WrittenDuring } from "../domain/journal-entry.ts";
import { timeLabelOf, writtenDuringBadgeOf, writtenDuringLabelOf } from "./journal-text.ts";
import { cn } from "./lib/utils.ts";
import { linkify } from "./linkify.ts";
import { TagList } from "./tag-input.tsx";

/** ジャーナル記入の表示の部品。タイムラインと、スタッツのジャーナル記入の見返しで使う */

/** 本文をプレーンテキストで出し、URL だけをリンクにする。改行はそのまま出す */
export const EntryBody = ({ text }: Readonly<{ text: string }>) => (
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
export const WrittenDuringBadge = ({
  writtenDuring,
}: Readonly<{ writtenDuring: WrittenDuring }>) => (
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

/** 読むだけの記入（スタッツのジャーナル記入の見返し）。編集・削除はタイムラインでする */
export const ReadOnlyEntry = ({ entry }: Readonly<{ entry: JournalEntry }>) => (
  <li aria-label="ジャーナル記入" className="flex flex-col gap-1.5 py-3.5">
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <time dateTime={entry.writtenAt.toISOString()}>{timeLabelOf(entry.writtenAt)}</time>
      <WrittenDuringBadge writtenDuring={entry.writtenDuring} />
      {entry.updatedAt.getTime() !== entry.writtenAt.getTime() && <span>編集済み</span>}
    </p>
    <EntryBody text={entry.body.unwrap()} />
    <TagList tags={entry.tags} />
  </li>
);
