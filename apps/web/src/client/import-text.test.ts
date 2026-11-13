import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { SessionEventId } from "../domain/session-event.ts";
import { SessionId } from "../domain/session.ts";
import {
  deviceSessionLabelOf,
  importFailureMessageOf,
  importResultLinesOf,
} from "./import-text.ts";

describe("取り込みの文言", () => {
  test("すべて取り込めたら、取り込んだ数だけを伝える", () => {
    expect(
      importResultLinesOf({ imported: 3, overlapping: 0, open: { kind: "NoOpenSession" } }, false),
    ).toEqual(["3セッションをアカウントに取り込みました。"]);
  });

  test("時間が重なったセッション・開いたままのセッション・タグの上限は、あるときだけ伝える", () => {
    const lines = importResultLinesOf(
      { imported: 1, overlapping: 2, open: { kind: "OpenSessionLeft" } },
      true,
    );

    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("2セッションは、アカウントの記録と時間が重なる");
    expect(lines[1]).toContain("設定画面の「アカウント」");
    expect(lines[2]).toContain("開いたままのセッションは、終えてから取り込めます");
    expect(lines[3]).toContain("20 種類を超えました");
  });

  test("この端末に残っているセッションは、始めた日と始めた時刻・終わった時刻で見分ける", () => {
    const session = {
      id: v.parse(SessionId.schema, crypto.randomUUID()),
      events: [
        {
          kind: "Start",
          id: v.parse(SessionEventId.schema, crypto.randomUUID()),
          at: new Date("2026-11-02T00:00:00Z"),
        },
      ],
      entries: [],
      endedAt: new Date("2026-11-02T00:30:00Z"),
      endedBy: "AutoEnd",
    } as const;

    expect(deviceSessionLabelOf(session, "Asia/Tokyo")).toMatch(/^11月2日（月） .+ 〜 .+$/);
  });

  test("途中で止まったら、やり直すと残りだけを取り込むと伝える", () => {
    expect(importFailureMessageOf({ kind: "Unreachable" })).toBe(
      "通信できませんでした。やり直すと、残りの記録だけを取り込みます。",
    );
  });
});
