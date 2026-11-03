import * as v from "valibot";
import { SessionId } from "../domain/session.ts";
import { DeletedTag, Tags, type TagName } from "../domain/tag.ts";

/**
 * 入力欄でつけたままのタグ（GLOSSARY の「タグ」）。外すかセッションが終わるまで、続けて書く記入につく。
 *
 * 端末ごとに localStorage に覚える（ADR 0013）。
 *
 * - `Prepared`: セッションの外でつけたタグ。これからやることとして準備しておき、次に始めるセッションに持ち越す
 * - `InSession`: セッション `sessionId` でつけている（準備したまま始めたものも含む）タグ。
 *   覚えているセッションと今のセッションが違えば、そのセッションは終わったので外れている
 */
const AttachedTagsSchema = v.variant("kind", [
  v.object({ kind: v.literal("Prepared"), tags: Tags.schema }),
  v.object({ kind: v.literal("InSession"), sessionId: SessionId.schema, tags: Tags.schema }),
]);

export type AttachedTags = v.InferOutput<typeof AttachedTagsSchema>;

const NONE: AttachedTags = { kind: "Prepared", tags: [] };

/**
 * 覚える localStorage のキー。記録先（GLOSSARY）ごとに分ける。覚えた値にはセッションの ID が入るので、
 * この端末の記録先とアカウントで共有すると、互いのセッションを「終わったもの」として外し合う（ADR 0019）。
 * アカウントのキーは、ログインして使っている人の既存の値を引き継ぐため変えない
 */
export type AttachedTagsKey = "nanaichi:attached-tags" | "nanaichi:attached-tags:device";

export const attachedTagsKeyOf = (
  recordStore: Readonly<{ kind: "Device" | "Account" }>,
): AttachedTagsKey => {
  switch (recordStore.kind) {
    case "Device":
      return "nanaichi:attached-tags:device";
    case "Account":
      return "nanaichi:attached-tags";
  }
};

/** localStorage に覚えている値（文字列）を読む。読めなければ何もついていない */
export const parseAttachedTags = (stored: string | null): AttachedTags => {
  if (stored === null) {
    return NONE;
  }
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), AttachedTagsSchema), stored);
  return parsed.success ? parsed.output : NONE;
};

/**
 * 今のセッション `sessionId`（なければ `undefined`）でつけたままのタグ。
 *
 * 準備したタグは、セッションの外でも、始めたセッションの中でもつく。
 * セッションでつけたタグは、そのセッションのあいだだけつく（終わったら外れ、セッションの外では何もついていない）。
 */
export const attachedTagsIn = (
  attached: AttachedTags,
  sessionId: SessionId | undefined,
): ReadonlyArray<TagName> => {
  switch (attached.kind) {
    case "Prepared":
      return attached.tags;
    case "InSession":
      return attached.sessionId === sessionId ? attached.tags : [];
  }
};

/**
 * 今のセッションでタグを `tags` にしたときに覚える値。セッションの外なら準備したタグになる。
 * セッションの中で準備したタグを見たら、このセッションのタグとして覚え直すのにも使う（終わったら外れるように）。
 */
export const attachTags = (
  sessionId: SessionId | undefined,
  tags: ReadonlyArray<TagName>,
): AttachedTags =>
  sessionId === undefined ? { kind: "Prepared", tags } : { kind: "InSession", sessionId, tags };

/**
 * タグを削除したら、つけたままのタグからも外す（付け替えたなら付け替え先に置き換える）。
 * そのまま続けて書くと、削除したタグがまた記入につき、使っているタグに戻ってしまうため（ADR 0017）
 */
export const withTagDeleted = (attached: AttachedTags, deleted: DeletedTag): AttachedTags => ({
  ...attached,
  tags: DeletedTag.applyTo(attached.tags, deleted),
});

/** localStorage に覚える値 */
export const serializeAttachedTags = (attached: AttachedTags): string => JSON.stringify(attached);
