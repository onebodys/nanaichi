import { describe, expect, test } from "vite-plus/test";
import { storageFailedMessageOf } from "./storage-failed-text.ts";

describe("この端末への保存に失敗したときの文言", () => {
  test("保存できる量を超えたら、ログインすると記録を残し続けられると伝える", () => {
    expect(storageFailedMessageOf({ kind: "StorageFailed", reason: "QuotaExceeded" })).toBe(
      "この端末に保存できる量を超えました。ログインすると記録を残し続けられます。",
    );
  });

  test("保存先が使えないとき、新しい版の記録のときは、それぞれ別の文言で伝える", () => {
    const unavailable = storageFailedMessageOf({ kind: "StorageFailed", reason: "Unavailable" });
    const newer = storageFailedMessageOf({ kind: "StorageFailed", reason: "NewerFormat" });
    expect(unavailable).toContain("保存できませんでした");
    expect(newer).toContain("新しい版");
  });
});
