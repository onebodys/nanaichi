import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { Tag, TAG_KINDS_MAX, TagName, Tags } from "./tag.ts";

const tag = (name: string) => v.parse(TagName.schema, name);
const tagsNumbered = (count: number, prefix = "tag") =>
  Array.from({ length: count }, (_, i) => tag(`${prefix}${i + 1}`));

describe("タグの名前", () => {
  test("先頭の # と前後の空白を外す", () => {
    expect(tag("  #読書 ")).toBe("読書");
  });

  test("英字の大文字・小文字を区別しない", () => {
    expect(tag("#Reading")).toBe(tag("reading"));
  });

  test("全角の英数字と ＃ は半角と同じタグになる", () => {
    expect(tag("＃ＲＥＡＤＩＮＧ２")).toBe(tag("reading2"));
  });

  test("ひらがなとカタカナは別のタグのまま", () => {
    expect(tag("どくしょ")).not.toBe(tag("ドクショ"));
  });

  test.each([[""], ["#"], ["  "], ["読書 メモ"], ["読書　メモ"]])(
    "空か空白を含む名前 %j はつけられない",
    (name) => {
      expect(v.safeParse(TagName.schema, name).success).toBe(false);
    },
  );

  test("20文字まではつけられ、21文字はつけられない。絵文字は1文字と数える", () => {
    expect(v.safeParse(TagName.schema, "あ".repeat(20)).success).toBe(true);
    expect(v.safeParse(TagName.schema, "👨‍👩‍👧".repeat(20)).success).toBe(true);
    expect(v.safeParse(TagName.schema, "あ".repeat(21)).success).toBe(false);
  });
});

describe("1件の記入につけるタグ", () => {
  test("つけた順に並び、表記ゆれを寄せたうえで同じ名前は1つにまとめる", () => {
    expect(v.parse(Tags.schema, ["読書", "#Book", "読書", "book"])).toEqual(["読書", "book"]);
  });
});

describe("使えるタグの種類の上限", () => {
  test(`ほかの記入で使っているタグとあわせて${TAG_KINDS_MAX}種類までならつけられる`, () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX - 1);

    expect(Tag.ensureWithinLimit(inUse, [tag("読書")])).toEqual(Result.succeed([tag("読書")]));
  });

  test(`${TAG_KINDS_MAX}種類を使っていると、新しいタグはつけられない`, () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX);

    expect(Tag.ensureWithinLimit(inUse, [tag("読書")])).toEqual(
      Result.fail({ kind: "TagLimitExceeded", limit: TAG_KINDS_MAX }),
    );
  });

  test(`${TAG_KINDS_MAX}種類を使っていても、使っているタグならつけられる`, () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX);

    expect(Result.isSuccess(Tag.ensureWithinLimit(inUse, [tag("tag1"), tag("tag2")]))).toBe(true);
  });

  test("入力欄でつけているタグとあわせて上限を超えるなら、新しいタグは作れない", () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX - 1);

    expect(Tag.canAdd(inUse, [], tag("読書"))).toBe(true);
    expect(Tag.canAdd(inUse, [tag("読書")], tag("本"))).toBe(false);
    expect(Tag.canAdd(inUse, [tag("読書")], tag("tag1"))).toBe(true);
  });
});
