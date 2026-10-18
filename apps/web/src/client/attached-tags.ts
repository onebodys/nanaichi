import * as v from "valibot";
import { SessionId } from "../domain/session.ts";
import { TagName, Tags } from "../domain/tag.ts";

/**
 * 入力欄でつけたままのタグ（GLOSSARY の「タグ」）。外すかセッションが終わるまで、続けて書く記入につく。
 *
 * 端末ごとに localStorage に、つけたときのセッションの ID と一緒に覚える（ADR 0013）。
 * 覚えているセッションと今のセッションが違えば、セッションが終わったので外れている。
 */
const AttachedTagsSchema = v.object({ sessionId: SessionId.schema, tags: Tags.schema });

export type AttachedTags = v.InferOutput<typeof AttachedTagsSchema>;

/** localStorage に覚えている値（文字列）から、セッション `sessionId` でつけたままのタグを読む */
export const attachedTagsOf = (
  stored: string | null,
  sessionId: SessionId | undefined,
): ReadonlyArray<TagName> => {
  if (stored === null || sessionId === undefined) {
    return [];
  }
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), AttachedTagsSchema), stored);
  return parsed.success && parsed.output.sessionId === sessionId ? parsed.output.tags : [];
};

/** localStorage に覚える値 */
export const serializeAttachedTags = (attached: AttachedTags): string => JSON.stringify(attached);
