import { describe, expect, test } from "vite-plus/test";
import { operationButtonsOf } from "./operation-layout.ts";

describe("操作ボタンの並びと目立たせ方", () => {
  test("集中中は一時停止を主にし、中断を控えめに、終了を文字だけで最後に置く", () => {
    expect(operationButtonsOf(["Pause", "Abort", "End"])).toEqual([
      { kind: "Pause", emphasis: "Primary" },
      { kind: "Abort", emphasis: "Secondary" },
      { kind: "End", emphasis: "Quiet" },
    ]);
  });

  test("休憩中は休憩スキップを主にして先頭に出し、一時停止は控えめにする", () => {
    expect(operationButtonsOf(["Pause", "SkipBreak", "End"])).toEqual([
      { kind: "SkipBreak", emphasis: "Primary" },
      { kind: "Pause", emphasis: "Secondary" },
      { kind: "End", emphasis: "Quiet" },
    ]);
  });

  test("一時停止中は再開を主にする", () => {
    expect(operationButtonsOf(["Resume", "Abort", "End"])).toEqual([
      { kind: "Resume", emphasis: "Primary" },
      { kind: "Abort", emphasis: "Secondary" },
      { kind: "End", emphasis: "Quiet" },
    ]);
  });

  test("中断のあとの待機では集中の再開始を主にする", () => {
    expect(operationButtonsOf(["RestartFocus", "End"])).toEqual([
      { kind: "RestartFocus", emphasis: "Primary" },
      { kind: "End", emphasis: "Quiet" },
    ]);
  });
});
