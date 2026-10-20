import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { SessionId } from "../domain/session.ts";
import { TagName } from "../domain/tag.ts";
import {
  attachedTagsIn,
  attachTags,
  parseAttachedTags,
  serializeAttachedTags,
  withTagDeleted,
} from "./attached-tags.ts";

const sessionId = v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000001");
const nextSessionId = v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000002");
const reading = v.parse(TagName.schema, "読書");

/** localStorage に覚えて読み直す */
const roundTrip = (sessionIdWhenAttached: SessionId | undefined) =>
  parseAttachedTags(serializeAttachedTags(attachTags(sessionIdWhenAttached, [reading])));

describe("入力欄でつけたままのタグ", () => {
  test("セッションの外でつけたタグは、準備したタグとしてセッションの外でもついている", () => {
    expect(attachedTagsIn(roundTrip(undefined), undefined)).toEqual(["読書"]);
  });

  test("準備したタグは、次に始めたセッションに持ち越される", () => {
    expect(attachedTagsIn(roundTrip(undefined), sessionId)).toEqual(["読書"]);
  });

  test("同じセッションのあいだは、つけたタグを覚えている", () => {
    expect(attachedTagsIn(roundTrip(sessionId), sessionId)).toEqual(["読書"]);
  });

  test("セッションが終わると、そのセッションでつけたタグは外れる", () => {
    expect(attachedTagsIn(roundTrip(sessionId), undefined)).toEqual([]);
  });

  test("次のセッションでは、前のセッションでつけたタグは外れている", () => {
    expect(attachedTagsIn(roundTrip(sessionId), nextSessionId)).toEqual([]);
  });

  test.each([[null], ["壊れた値"], ['{"sessionId":"x","tags":[]}']])(
    "覚えている値 %j が読めなければ、タグはついていない",
    (stored) => {
      expect(attachedTagsIn(parseAttachedTags(stored), sessionId)).toEqual([]);
    },
  );
});

describe("タグを削除したときのつけたままのタグ", () => {
  const book = v.parse(TagName.schema, "本");
  const design = v.parse(TagName.schema, "設計");

  test("外しただけなら、つけたままのタグからも外れ、続けて書く記入につかない", () => {
    const attached = attachTags(sessionId, [reading, design]);

    expect(withTagDeleted(attached, { name: reading, deletion: { kind: "Detach" } })).toEqual(
      attachTags(sessionId, [design]),
    );
  });

  test("付け替えたなら、準備したタグも付け替え先に置き換わる", () => {
    const attached = attachTags(undefined, [reading]);

    expect(
      withTagDeleted(attached, { name: reading, deletion: { kind: "Reassign", to: book } }),
    ).toEqual(attachTags(undefined, [book]));
  });
});
