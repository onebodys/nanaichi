import { useCallback, useEffect, useRef, useState } from "react";
import { Result } from "@praha/byethrow";
import type { EntriesOnDate, JournalCalendar, JournalMonth } from "../domain/journal-calendar.ts";
import type { JournalEntry } from "../domain/journal-entry.ts";
import type { LocalDate } from "../domain/local-date.ts";
import type { TagName } from "../domain/tag.ts";
import { TaggedEntries, type TaggedEntriesCursor } from "../domain/tagged-entries.ts";
import type { BackendError } from "../domain/backend.ts";
import { useBackend } from "./backend.ts";
import { deviceTimeZone } from "./use-stats.ts";

/** 読み込んだものの様子。読み込み直している間は、前に読み込んだ同じものを出し続ける */
export type LoadView<T> =
  | Readonly<{ kind: "Loading" }>
  | Readonly<{ kind: "LoadFailed" }>
  | Readonly<{ kind: "Loaded"; value: T }>;

/**
 * `key` が変わるたびに `load` で読み込む。続けて切り替えたとき、古い応答で新しい表示を上書きしないよう、
 * 最後の読み込みだけを受け取る（`useStats` と同じ）
 */
const useLoad = <T>(
  key: string,
  load: () => Result.ResultAsync<T, BackendError>,
): Readonly<{ view: LoadView<T>; reload: () => void }> => {
  const [loaded, setLoaded] = useState<Readonly<{ key: string; value: T }> | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const latestLoad = useRef(load);
  useEffect(() => {
    latestLoad.current = load;
  });

  useEffect(() => {
    latest.current += 1;
    const request = latest.current;
    void latestLoad.current().then((result) => {
      if (request !== latest.current) {
        return;
      }
      if (Result.isSuccess(result)) {
        setLoaded({ key, value: result.value });
        setFailed(undefined);
        return;
      }
      setFailed(key);
    });
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  if (loaded !== undefined && loaded.key === key) {
    return { view: { kind: "Loaded", value: loaded.value }, reload };
  }
  return { view: failed === key ? { kind: "LoadFailed" } : { kind: "Loading" }, reload };
};

/** ジャーナルのカレンダー（GLOSSARY）の1か月分。日付は端末のタイムゾーンで区切る */
export const useJournalCalendar = (month: JournalMonth) => {
  const backend = useBackend();
  return useLoad<JournalCalendar>(`${month.year}-${month.month}`, () =>
    backend.getJournalCalendar(month, deviceTimeZone()),
  );
};

/** 選んだ日の記入 */
export const useEntriesOnDate = (date: LocalDate) => {
  const backend = useBackend();
  return useLoad<EntriesOnDate>(date.key, () => backend.getEntriesOnDate(date, deviceTimeZone()));
};

/** タグのついた記入。読み込んだページを重ねたもの */
export type TaggedEntriesView = LoadView<
  Readonly<{ entries: ReadonlyArray<JournalEntry>; next: TaggedEntriesCursor }>
>;

/**
 * タグ `tag` のついた記入を、新しい順にページで読む。`loadMore` で続きのページを足す
 * （タイムラインと同じく、末尾の「さらに読み込む」から）
 */
export const useTaggedEntries = (
  tag: TagName,
): Readonly<{
  view: TaggedEntriesView;
  loadingMore: boolean;
  loadMore: () => void;
  reload: () => void;
}> => {
  const backend = useBackend();
  const first = useLoad(tag, () => backend.getEntriesWithTag(tag));
  // 足したページ。タグを切り替えたら捨てる
  const [more, setMore] = useState<
    Readonly<{ tag: TagName; entries: ReadonlyArray<JournalEntry>; next: TaggedEntriesCursor }>
  >({ tag, entries: [], next: { kind: "End" } });
  const [loadingMore, setLoadingMore] = useState(false);

  const view: TaggedEntriesView =
    first.view.kind === "Loaded"
      ? {
          kind: "Loaded",
          value:
            more.tag === tag && more.entries.length > 0
              ? {
                  entries: TaggedEntries.merge(first.view.value.entries, more.entries),
                  next: more.next,
                }
              : { entries: first.view.value.entries, next: first.view.value.next },
        }
      : first.view;

  const loadMore = () => {
    if (view.kind !== "Loaded" || view.value.next.kind !== "More" || loadingMore) {
      return;
    }
    setLoadingMore(true);
    void backend.getEntriesWithTag(tag, view.value.next.before).then((result) => {
      setLoadingMore(false);
      if (Result.isSuccess(result)) {
        setMore((current) => ({
          tag: result.value.tag,
          entries: TaggedEntries.merge(
            current.tag === result.value.tag ? current.entries : [],
            result.value.entries,
          ),
          next: result.value.next,
        }));
        return;
      }
      // 続きを読めなければ、ボタンを残してもう一度押せるようにする
    });
  };

  const reload = () => {
    setMore({ tag, entries: [], next: { kind: "End" } });
    first.reload();
  };

  return { view, loadingMore, loadMore, reload };
};
