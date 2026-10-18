import { describe, expect, test } from "vite-plus/test";
import { backgroundTimerLabelOf, permissionNoteOf, toneTargetOf } from "./settings-text.ts";

describe("音色を選ぶ行", () => {
  test("行き先のフェーズで見出しを書く（ジャーナルの終わりは集中にも休憩にも行くため）", () => {
    expect(toneTargetOf("Journal").label).toBe("ジャーナルに入るとき");
    expect(toneTargetOf("Focus").label).toBe("集中に入るとき");
    expect(toneTargetOf("Break").label).toBe("休憩に入るとき");
  });
});

describe("ブラウザ通知の許可の説明", () => {
  test("まだ聞いていなければ、セッションの開始時に許可を求めると説明する", () => {
    expect(permissionNoteOf("default")).toBe(
      "セッションを開始するときに、ブラウザが許可を求めます",
    );
  });

  test("拒否されていれば、ブラウザのサイトの設定から許可するよう案内する", () => {
    expect(permissionNoteOf("denied")).toContain("サイトの設定から許可");
  });
});

describe("設定画面を開いている間のタイマーの様子", () => {
  test("集中中はフェーズと残り時間を出す", () => {
    expect(
      backgroundTimerLabelOf({
        kind: "Focus",
        round: 1,
        setNumber: 2,
        completedSets: 1,
        remainingSeconds: 4 * 60 + 12,
        clock: { kind: "Running", endsAt: new Date(0) },
      }),
    ).toBe("集中 4:12");
  });

  test("一時停止中のジャーナルは、止まっていることも添える", () => {
    expect(
      backgroundTimerLabelOf({
        kind: "Journal",
        round: 1,
        setNumber: 2,
        completedSets: 2,
        remainingSeconds: 38,
        clock: { kind: "Paused", pausedAt: new Date(0) },
      }),
    ).toBe("ジャーナル 0:38（一時停止中）");
  });

  test("中断のあとの待機では、待機とだけ出す", () => {
    expect(backgroundTimerLabelOf({ kind: "Idle", round: 1, setNumber: 2, completedSets: 1 })).toBe(
      "待機",
    );
  });
});
