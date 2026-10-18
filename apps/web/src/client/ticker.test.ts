import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { startTicker, type CreateTickSource } from "./ticker.ts";

/** Worker の代わりに、頼まれた間隔を記録し、テストから刻みを送れるようにする */
const fakeWorker = () => {
  const state = {
    intervals: new Array<number>(),
    listeners: new Array<() => void>(),
    stopped: false,
  };
  const create: CreateTickSource = (intervalMs) => {
    state.intervals.push(intervalMs);
    return {
      onTick: (listener) => state.listeners.push(listener),
      stop: () => {
        state.stopped = true;
      },
    };
  };
  return { state, create, tick: () => state.listeners.forEach((listener) => listener()) };
};

describe("刻み", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("Worker を作れるときは Worker の刻みで呼び、画面のスレッドのタイマーは使わない", () => {
    const worker = fakeWorker();
    const onTick = vi.fn();
    startTicker(250, onTick, worker.create);

    expect(worker.state.intervals).toEqual([250]);
    vi.advanceTimersByTime(1000);
    expect(onTick).not.toHaveBeenCalled();

    worker.tick();
    worker.tick();
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  test("止めると Worker も止まる", () => {
    const worker = fakeWorker();
    const stop = startTicker(250, vi.fn(), worker.create);

    stop();

    expect(worker.state.stopped).toBe(true);
  });

  test("Worker を作れないときは画面のスレッドのタイマーで刻み、止めると止まる", () => {
    const onTick = vi.fn();
    const stop = startTicker(250, onTick, () => undefined);

    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(4);

    stop();
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(4);
  });
});
