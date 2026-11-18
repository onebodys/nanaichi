import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createLoadRetry } from "./load-retry.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("読み込みの失敗のやり直し", () => {
  test("読み込みが失敗すると、1秒後に読み込み直す", () => {
    const retry = createLoadRetry();
    const load = vi.fn();

    retry.failed(load);
    vi.advanceTimersByTime(999);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("読み込み直しも失敗し続けると、間隔を倍にしていき、30秒より空けない", () => {
    const retry = createLoadRetry();
    const delays: Array<number> = [];
    let last = Date.now();
    const load = () => {
      delays.push(Date.now() - last);
      last = Date.now();
      retry.failed(load);
    };

    retry.failed(load);
    vi.advanceTimersByTime(1000 + 2000 + 4000 + 8000 + 16_000 + 30_000 + 30_000);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  });

  test("読み込めたら、次の失敗はまた1秒後からやり直す", () => {
    const retry = createLoadRetry();
    const load = vi.fn();

    retry.failed(load);
    vi.advanceTimersByTime(1000);
    retry.failed(load);
    vi.advanceTimersByTime(2000);
    expect(load).toHaveBeenCalledTimes(2);

    retry.succeeded();
    retry.failed(load);
    vi.advanceTimersByTime(1000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  test("やり直しを待っている間に別の読み込みが失敗しても、読み込み直すのは1回", () => {
    const retry = createLoadRetry();
    const load = vi.fn();

    retry.failed(load);
    retry.failed(load);
    vi.advanceTimersByTime(60_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("画面を閉じたら、待っているやり直しはしない", () => {
    const retry = createLoadRetry();
    const load = vi.fn();

    retry.failed(load);
    retry.stop();
    vi.advanceTimersByTime(60_000);
    expect(load).not.toHaveBeenCalled();
  });
});
