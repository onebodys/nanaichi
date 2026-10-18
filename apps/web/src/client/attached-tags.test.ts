import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { SessionId } from "../domain/session.ts";
import { TagName } from "../domain/tag.ts";
import { attachedTagsOf, serializeAttachedTags } from "./attached-tags.ts";

const sessionId = v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000001");
const nextSessionId = v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000002");
const reading = v.parse(TagName.schema, "読書");

describe("入力欄でつけたままのタグ", () => {
  test("同じセッションのあいだは、つけたタグを覚えている", () => {
    const stored = serializeAttachedTags({ sessionId, tags: [reading] });

    expect(attachedTagsOf(stored, sessionId)).toEqual(["読書"]);
  });

  test("次のセッションでは、前のセッションでつけたタグは外れている", () => {
    const stored = serializeAttachedTags({ sessionId, tags: [reading] });

    expect(attachedTagsOf(stored, nextSessionId)).toEqual([]);
  });

  test("セッションがなければ、タグはついていない", () => {
    const stored = serializeAttachedTags({ sessionId, tags: [reading] });

    expect(attachedTagsOf(stored, undefined)).toEqual([]);
  });

  test.each([[null], ["壊れた値"], ['{"sessionId":"x","tags":[]}']])(
    "覚えている値 %j が読めなければ、タグはついていない",
    (stored) => {
      expect(attachedTagsOf(stored, sessionId)).toEqual([]);
    },
  );
});
