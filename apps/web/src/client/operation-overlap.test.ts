import { describe, expect, test } from "vite-plus/test";
import { createOperationTracker } from "./operation-overlap.ts";

describe("操作と重なった読み込み", () => {
  test("操作のない間に送って受け取った読み込みは、重なっていない", () => {
    const tracker = createOperationTracker();

    const token = tracker.readStarted();

    expect(tracker.overlapped(token)).toBe(false);
  });

  test("読み込みの途中で開始を送ると、開始の応答より後に届いた読み込みは重なっている", () => {
    const tracker = createOperationTracker();
    const token = tracker.readStarted();

    tracker.begin();
    tracker.end();

    expect(tracker.overlapped(token)).toBe(true);
  });

  test("開始の応答を待っている間に送った読み込みは、開始より先に届いても重なっている", () => {
    const tracker = createOperationTracker();
    tracker.begin();

    const token = tracker.readStarted();

    expect(tracker.overlapped(token)).toBe(true);
  });

  test("操作を受け取り終えてから送った読み込みは、重なっていない", () => {
    const tracker = createOperationTracker();
    tracker.begin();
    tracker.end();

    const token = tracker.readStarted();

    expect(tracker.overlapped(token)).toBe(false);
  });
});
