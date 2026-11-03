import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { DeletedTag, Tag, TAG_KINDS_MAX, TagName, Tags } from "./tag.ts";

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
  const within = (input: Parameters<typeof Tag.ensureWithinLimit>[0]) =>
    Result.isSuccess(Tag.ensureWithinLimit(input));

  test(`ほかの記入で使っているタグとあわせて${TAG_KINDS_MAX}種類までならつけられる`, () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX - 1);

    expect(Tag.ensureWithinLimit({ inUse, kept: [], tags: [tag("読書")] })).toEqual(
      Result.succeed([tag("読書")]),
    );
  });

  test(`${TAG_KINDS_MAX}種類を使っていると、新しいタグはつけられない`, () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX);

    expect(Tag.ensureWithinLimit({ inUse, kept: [], tags: [tag("読書")] })).toEqual(
      Result.fail({ kind: "TagLimitExceeded", limit: TAG_KINDS_MAX }),
    );
  });

  test(`${TAG_KINDS_MAX}種類を使っていても、使っているタグならつけられる`, () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX);

    expect(within({ inUse, kept: [], tags: [tag("tag1"), tag("tag2")] })).toBe(true);
  });

  test(`使っているタグが${TAG_KINDS_MAX}種類を超えていても、タグをつけない記入は書ける`, () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX + 5);

    expect(within({ inUse, kept: [], tags: [] })).toBe(true);
  });

  test(`使っているタグが${TAG_KINDS_MAX}種類を超えていても、使っているタグだけをつける記入は書ける`, () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX + 5);

    expect(within({ inUse, kept: [], tags: [tag("tag3"), tag("tag25")] })).toBe(true);
  });

  test("上限を超えたアカウントで、その記入にしかないタグをつけた記入の本文を書き直せる", () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX + 1);

    expect(within({ inUse, kept: [tag("読書")], tags: [tag("読書")] })).toBe(true);
    expect(within({ inUse, kept: [tag("読書")], tags: [] })).toBe(true);
  });

  test("上限を超えたアカウントで、まだ使っていないタグをつけて書き直すことはできない", () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX + 1);

    expect(within({ inUse, kept: [tag("読書")], tags: [tag("読書"), tag("本")] })).toBe(false);
  });

  test("その記入にしかないタグを外して新しいタグに付け替えるなら、種類が増えないのでつけられる", () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX - 1);

    expect(within({ inUse, kept: [tag("読書")], tags: [tag("本")] })).toBe(true);
    expect(within({ inUse, kept: [tag("読書")], tags: [tag("読書"), tag("本")] })).toBe(false);
  });

  test("まだ使っていないタグをつけて合わせて上限を超えるなら、タグの上限で断る", () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX - 1);

    expect(within({ inUse, kept: [], tags: [tag("読書"), tag("本")] })).toBe(false);
    expect(within({ inUse, kept: [], tags: [tag("読書")] })).toBe(true);
  });

  test("入力欄でつけているタグとあわせて上限を超えるなら、新しいタグは作れない", () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX - 1);

    expect(Tag.canAdd(inUse, [], tag("読書"))).toBe(true);
    expect(Tag.canAdd(inUse, [tag("読書")], tag("本"))).toBe(false);
    expect(Tag.canAdd(inUse, [tag("読書")], tag("tag1"))).toBe(true);
  });

  test(`使っているタグが${TAG_KINDS_MAX}種類を超えていても、使っているタグは入力欄でつけられる`, () => {
    const inUse = tagsNumbered(TAG_KINDS_MAX + 5);

    expect(Tag.canAdd(inUse, [tag("tag1")], tag("tag2"))).toBe(true);
    expect(Tag.canAdd(inUse, [], tag("本"))).toBe(false);
  });
});

describe("タグの削除", () => {
  const reading = tag("読書");
  const design = tag("設計");
  const review = tag("レビュー");
  const inUse = [reading, design, review];

  test("使っているタグは、外すだけなら削除できる", () => {
    const deleted: DeletedTag = { name: reading, deletion: { kind: "Detach" } };

    expect(DeletedTag.ensureDeletable(inUse, deleted)).toEqual(Result.succeed(deleted));
  });

  test("使っている別のタグになら、付け替えて削除できる", () => {
    const deleted: DeletedTag = { name: reading, deletion: { kind: "Reassign", to: design } };

    expect(DeletedTag.ensureDeletable(inUse, deleted)).toEqual(Result.succeed(deleted));
  });

  test("どの記入にもついていないタグは存在しないので、削除できない", () => {
    const deleted: DeletedTag = { name: tag("料理"), deletion: { kind: "Detach" } };

    expect(DeletedTag.ensureDeletable(inUse, deleted)).toEqual(
      Result.fail({ kind: "TagNotFound", name: "料理" }),
    );
  });

  test("付け替え先は使っているタグから選ぶので、使っていないタグには付け替えられない", () => {
    const deleted: DeletedTag = {
      name: reading,
      deletion: { kind: "Reassign", to: tag("料理") },
    };

    expect(DeletedTag.ensureDeletable(inUse, deleted)).toEqual(
      Result.fail({ kind: "TagNotFound", name: "料理" }),
    );
  });

  test("削除するタグ自身には付け替えられない", () => {
    const deleted: DeletedTag = { name: reading, deletion: { kind: "Reassign", to: reading } };

    expect(DeletedTag.ensureDeletable(inUse, deleted)).toEqual(
      Result.fail({ kind: "ReassignToSameTag" }),
    );
  });

  test("外すだけなら、記入のタグから削除したタグだけがなくなり、残りの順は変わらない", () => {
    expect(
      DeletedTag.applyTo([design, reading, review], {
        name: reading,
        deletion: { kind: "Detach" },
      }),
    ).toEqual([design, review]);
  });

  test("付け替えると、削除したタグのあった位置に付け替え先がつく", () => {
    expect(
      DeletedTag.applyTo([design, reading], {
        name: reading,
        deletion: { kind: "Reassign", to: review },
      }),
    ).toEqual([design, review]);
  });

  test("付け替え先がすでについている記入では、先にあった位置の1つにまとめる", () => {
    expect(
      DeletedTag.applyTo([reading, review, design], {
        name: reading,
        deletion: { kind: "Reassign", to: design },
      }),
    ).toEqual([design, review]);
  });

  test("削除したタグがついていない記入のタグは変わらない", () => {
    expect(
      DeletedTag.applyTo([design, review], {
        name: reading,
        deletion: { kind: "Reassign", to: design },
      }),
    ).toEqual([design, review]);
  });
});
