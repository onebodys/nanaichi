import { Result } from "@praha/byethrow";
import { describe, expect, test, vi } from "vite-plus/test";
import { sessionOf, type SessionSpec } from "../testing/golden-values.ts";
import {
  TIMELINE_PAGE_SIZE,
  type TimelineRange,
  type TimelineSession,
} from "../domain/timeline.ts";
import { getTimeline } from "./get-timeline.ts";

const NOW = new Date(Date.UTC(2026, 9, 17, 14, 30, 0));
const MINUTE = 60_000;

/** 番号 `n` のセッションは、`n` 分前に始まって終わっている（番号が小さいほど新しい） */
const spec = (n: number): SessionSpec => ({
  n,
  startedAt: new Date(NOW.getTime() - n * MINUTE),
  operations: [{ kind: "End", at: new Date(NOW.getTime() - n * MINUTE + 1000) }],
});

/** 記録に新しい順で `count` 件のセッションがあり、`limit` 件までしか読めない */
const recordWith = (count: number) =>
  vi.fn((range: TimelineRange): ReadonlyArray<TimelineSession> => {
    const all = Array.from({ length: count }, (_, i) => ({
      session: sessionOf(spec(i + 1)),
      entries: [],
    }));
    return all.slice(0, range.limit);
  });

const depsOver = (findTimelineSessions: ReturnType<typeof recordWith>) => ({
  findOpenSession: () => undefined,
  closeSession: vi.fn(),
  findTimelineSessions,
});

describe("タイムラインの1ページを読む", () => {
  test("最新のページは、次のページがあるか見分けるために1ページ分より1件多く読み、返すのは1ページ分だけ", () => {
    const find = recordWith(TIMELINE_PAGE_SIZE + 5);

    const result = getTimeline(depsOver(find))({}, NOW);

    expect(find).toHaveBeenCalledWith({ kind: "Latest", limit: TIMELINE_PAGE_SIZE + 1 });
    expect(Result.isSuccess(result) && result.value.sessions).toHaveLength(TIMELINE_PAGE_SIZE);
    expect(Result.isSuccess(result) && result.value.next.kind).toBe("More");
  });

  test("before を渡した続きのページも、1ページ分より1件多く読み、続きがあれば More を返す", () => {
    const find = recordWith(TIMELINE_PAGE_SIZE + 5);
    const before = new Date(NOW.getTime() - 60 * MINUTE);

    const result = getTimeline(depsOver(find))({ before: before.toISOString() }, NOW);

    expect(find).toHaveBeenCalledWith({
      kind: "Before",
      before,
      limit: TIMELINE_PAGE_SIZE + 1,
    });
    expect(Result.isSuccess(result) && result.value.sessions).toHaveLength(TIMELINE_PAGE_SIZE);
    expect(Result.isSuccess(result) && result.value.next.kind).toBe("More");
  });

  test("続きのページがちょうど1ページ分で終わるなら、続きはない", () => {
    const find = recordWith(TIMELINE_PAGE_SIZE);
    const before = new Date(NOW.getTime() - 60 * MINUTE);

    const result = getTimeline(depsOver(find))({ before: before.toISOString() }, NOW);

    expect(Result.isSuccess(result) && result.value.next).toEqual({ kind: "End" });
  });

  test("before が時刻として読めなければ、記録を読まずに ValidationError を返す", () => {
    const find = recordWith(1);

    const result = getTimeline(depsOver(find))({ before: "yesterday" }, NOW);

    expect(Result.isFailure(result) && result.error.kind).toBe("ValidationError");
    expect(find).not.toHaveBeenCalled();
  });
});
