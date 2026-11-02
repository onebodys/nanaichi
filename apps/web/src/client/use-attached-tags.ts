import { useEffect, useSyncExternalStore } from "react";
import type { SessionId } from "../domain/session.ts";
import type { DeletedTag, TagName } from "../domain/tag.ts";
import {
  attachedTagsIn,
  attachTags,
  type AttachedTagsKey,
  parseAttachedTags,
  serializeAttachedTags,
  withTagDeleted,
} from "./attached-tags.ts";

/**
 * 入力欄でつけたままのタグを、端末ごとに覚える（GLOSSARY の「タグ」、ADR 0013）。
 *
 * localStorage は使えないこと（プライベートブラウズ・サイトデータのブロック）もあるので、
 * 読み書きに失敗したら、開いている画面の中でだけ覚える（use-submit-key.ts と同じ）。
 *
 * 覚えた値はセッションの ID を含むので、記録先（GLOSSARY）ごとの `key` に分ける。
 * 分けないと、この端末の画面とアカウントの画面が互いのつけたタグを「終わったセッションのもの」として消し合う
 */
const listeners = new Set<() => void>();
/** localStorage に書けなかったときも、開いている画面の中ではつけたタグを使う */
const fallbacks = new Map<AttachedTagsKey, string>();

const readStored = (key: AttachedTagsKey): string | null => {
  try {
    return localStorage.getItem(key) ?? fallbacks.get(key) ?? null;
  } catch {
    return fallbacks.get(key) ?? null;
  }
};

const subscribe = (key: AttachedTagsKey) => (listener: () => void) => {
  listeners.add(listener);
  // 同じ端末の別のタブでつけ外ししたときも揃える
  const onStorage = (event: StorageEvent) => {
    if (event.key === key) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
};

const write = (key: AttachedTagsKey, stored: string) => {
  fallbacks.set(key, stored);
  try {
    localStorage.setItem(key, stored);
  } catch {
    // 覚えられなくても、この画面では fallback でつけたタグを使う
  }
  for (const listener of listeners) listener();
};

/** 同じ値を読んだら同じ配列を返す（useSyncExternalStore は読むたびに同じ値を返す必要がある） */
const caches = new Map<
  AttachedTagsKey,
  Readonly<{
    stored: string | null;
    sessionId: SessionId | undefined;
    tags: ReadonlyArray<TagName>;
  }>
>();

const read = (key: AttachedTagsKey, sessionId: SessionId | undefined): ReadonlyArray<TagName> => {
  const stored = readStored(key);
  const cache = caches.get(key);
  if (cache !== undefined && cache.stored === stored && cache.sessionId === sessionId) {
    return cache.tags;
  }
  const tags = attachedTagsIn(parseAttachedTags(stored), sessionId);
  caches.set(key, { stored, sessionId, tags });
  return tags;
};

/**
 * 今のセッション `sessionId`（なければ `undefined`）で入力欄につけたままのタグと、それを変える関数。
 *
 * セッションの外でもつけられ、準備したタグとして次に始めるセッションに持ち越す。
 * セッションの中で準備したタグを見たら、このセッションのタグとして覚え直し、セッションが終わったら外れるようにする。
 */
export const useAttachedTags = (
  key: AttachedTagsKey,
  sessionId: SessionId | undefined,
): readonly [ReadonlyArray<TagName>, (tags: ReadonlyArray<TagName>) => void] => {
  const tags = useSyncExternalStore(subscribe(key), () => read(key, sessionId));

  useEffect(() => {
    const attached = parseAttachedTags(readStored(key));
    if (sessionId !== undefined && attached.kind === "Prepared" && attached.tags.length > 0) {
      write(key, serializeAttachedTags(attachTags(sessionId, attached.tags)));
    }
  }, [key, sessionId]);

  return [tags, (next) => write(key, serializeAttachedTags(attachTags(sessionId, next)))];
};

/**
 * 削除したタグを、この端末でつけたままのタグからも外す（付け替えたなら付け替え先に置き換える、ADR 0017）。
 * 削除したタグをつけていなければ何もしない
 */
export const applyTagDeletionToAttached = (key: AttachedTagsKey, deleted: DeletedTag): void => {
  const stored = readStored(key);
  const next = serializeAttachedTags(withTagDeleted(parseAttachedTags(stored), deleted));
  if (stored !== null && next !== stored) {
    write(key, next);
  }
};
