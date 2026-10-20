import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { TagName } from "../domain/tag.ts";
import {
  backgroundTimerLabelOf,
  permissionNoteOf,
  tagDeletionActionOf,
  tagKindsNoteOf,
  toneTargetOf,
  transitionLabelOf,
} from "./settings-text.ts";

describe("フェーズの進め方の行", () => {
  test("どのフェーズからどのフェーズへの切り替わりかを矢印で書く", () => {
    expect(transitionLabelOf("FocusToJournal").label).toBe("集中 → ジャーナル");
    expect(transitionLabelOf("JournalToFocus").label).toBe("ジャーナル → 集中");
    expect(transitionLabelOf("JournalToBreak").label).toBe("ジャーナル → 休憩");
    expect(transitionLabelOf("BreakToFocus").label).toBe("休憩 → 集中");
  });
});

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

  test("切り替え待ちでは、どのフェーズの前で待っているかを出す", () => {
    expect(
      backgroundTimerLabelOf({
        kind: "AwaitingAdvance",
        finished: { kind: "Focus", round: 1, setNumber: 1 },
        completedSets: 1,
        since: new Date(0),
      }),
    ).toBe("ジャーナルの前で待っています");
  });

  test("中断のあとの待機では、待機とだけ出す", () => {
    expect(backgroundTimerLabelOf({ kind: "Idle", round: 1, setNumber: 2, completedSets: 1 })).toBe(
      "待機",
    );
  });
});

describe("タグの削除", () => {
  test("使っているタグの種類を上限とあわせて書く", () => {
    expect(tagKindsNoteOf(3)).toBe("使えるタグは20種類までで、いま3種類を使っています。");
  });

  test("削除のボタンには、外すのか、どのタグに付け替えるのかを書く", () => {
    expect(tagDeletionActionOf({ kind: "Detach" })).toBe("外して削除");
    expect(tagDeletionActionOf({ kind: "Reassign", to: v.parse(TagName.schema, "本") })).toBe(
      "#本 に付け替えて削除",
    );
  });
});
