import { describe, expect, test } from "vite-plus/test";
import { completedSetsLabelOf, dateLabelOf, writtenDuringLabelOf } from "./journal-text.ts";

describe("タイムラインの文言", () => {
  test("日付の区切りは月日と曜日で出す", () => {
    expect(dateLabelOf({ key: "2026-10-17", year: 2026, month: 10, day: 17 })).toBe(
      "10月17日（土）",
    );
  });

  test("その日の完了セット数を出し、確定していなければ続きを読み込むよう促す", () => {
    expect(completedSetsLabelOf({ kind: "Counted", count: 6 })).toBe("完了セット 6");
    expect(completedSetsLabelOf({ kind: "NotYetCounted" })).toBe(
      "完了セットは続きを読み込むと出ます",
    );
  });

  test.each([
    [{ kind: "Focus", round: 1, setNumber: 2 } as const, "1ラウンド目・2セット目・集中"],
    [{ kind: "Journal", round: 2, setNumber: 3 } as const, "2ラウンド目・3セット目・ジャーナル"],
    [{ kind: "Break", round: 1 } as const, "1ラウンド目・休憩"],
    [{ kind: "Idle", round: 1, setNumber: 2 } as const, "1ラウンド目・2セット目・待機"],
  ])("書いたときの状態 %j は「%s」", (writtenDuring, label) => {
    expect(writtenDuringLabelOf(writtenDuring)).toBe(label);
  });
});
