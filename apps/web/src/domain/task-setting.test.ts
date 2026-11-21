import { describe, expect, test } from "vite-plus/test";
import { TaskSetting } from "./task-setting.ts";

const enabled: TaskSetting = { kind: "Enabled" };
const disabled: TaskSetting = { kind: "Disabled" };

describe("ToDo の設定", () => {
  test("有効同士、無効同士は同じ設定", () => {
    expect(TaskSetting.equals(enabled, { kind: "Enabled" })).toBe(true);
    expect(TaskSetting.equals(disabled, { kind: "Disabled" })).toBe(true);
  });

  test("有効と無効は違う設定", () => {
    expect(TaskSetting.equals(enabled, disabled)).toBe(false);
    expect(TaskSetting.equals(disabled, enabled)).toBe(false);
  });
});
