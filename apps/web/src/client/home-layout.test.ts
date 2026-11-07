import { describe, expect, it } from "vite-plus/test";
import { homeLayoutOf } from "./home-layout.ts";

describe("ホーム画面の配置", () => {
  it("ToDo を使う設定のときは、タイマーを簡略にして ToDo を並べる配置になる", () => {
    expect(homeLayoutOf({ kind: "Loaded", setting: { kind: "Enabled" } })).toEqual({
      kind: "WithTasks",
    });
  });

  it("ToDo を使わない設定のときは、従来の配置のままになる", () => {
    expect(homeLayoutOf({ kind: "Loaded", setting: { kind: "Disabled" } })).toEqual({
      kind: "Standard",
    });
  });

  it("この端末の記録先と、設定を読み込めるまでは、従来の配置のままになる", () => {
    expect(homeLayoutOf({ kind: "Unavailable" })).toEqual({ kind: "Standard" });
    expect(homeLayoutOf({ kind: "Loading" })).toEqual({ kind: "Standard" });
    expect(homeLayoutOf({ kind: "LoadFailed" })).toEqual({ kind: "Standard" });
  });
});
