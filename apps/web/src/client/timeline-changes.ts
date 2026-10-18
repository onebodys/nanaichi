import { Timeline, type TimelineSession } from "../domain/timeline.ts";

/** 読み込んだ記録に当てる変更（記入を書いた・編集した・削除した、現在のセッションを重ねた） */
export type TimelineChange = (
  sessions: ReadonlyArray<TimelineSession>,
) => ReadonlyArray<TimelineSession>;

/**
 * 読み込み直した最新のページを、手元の記録に重ねる。
 *
 * ページを読み込んでいる間に届いた変更（同期メッセージ・自分の書き込み）は、ページより新しいことがある。
 * 応答のほうが後に届くと、ページで置き換えたときにその変更が消えてしまう（書いた記入が一度出てから消える）。
 * そのため、ページで置き換えたあとに、読み込み始めてから届いた変更 `since` を順に当て直す。
 * どの変更も同じ記入・セッションで置き換えるだけなので、ページにすでに含まれていても二重にはならない。
 */
export const mergeLatestPage = (
  sessions: ReadonlyArray<TimelineSession>,
  page: ReadonlyArray<TimelineSession>,
  since: ReadonlyArray<TimelineChange>,
): ReadonlyArray<TimelineSession> =>
  since.reduce((merged, change) => change(merged), Timeline.merge(sessions, page));
