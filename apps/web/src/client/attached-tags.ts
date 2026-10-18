import * as v from "valibot";
import { SessionId } from "../domain/session.ts";
import { Tags, type TagName } from "../domain/tag.ts";

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

/** localStorage に覚える値 */
export const serializeAttachedTags = (attached: AttachedTags): string => JSON.stringify(attached);
