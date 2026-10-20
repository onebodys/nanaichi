import { useEffect, useSyncExternalStore } from "react";
import type { SessionId } from "../domain/session.ts";
import type { DeletedTag, TagName } from "../domain/tag.ts";
import {
  attachedTagsIn,
  attachTags,
  parseAttachedTags,
  serializeAttachedTags,
  withTagDeleted,
} from "./attached-tags.ts";

/**
 * 入力欄でつけたままのタグを、端末ごとに覚える（GLOSSARY の「タグ」、ADR 0013）。
 *
 * localStorage は使えないこと（プライベートブラウズ・サイトデータのブロック）もあるので、
 * 読み書きに失敗したら、開いている画面の中でだけ覚える（use-submit-key.ts と同じ）。
 */
const storageKey = "nanaichi:attached-tags";

const listeners = new Set<() => void>();
/** localStorage に書けなかったときも、開いている画面の中ではつけたタグを使う */
let fallback: string | null = null;

const readStored = (): string | null => {
  try {
    return localStorage.getItem(storageKey) ?? fallback;
  } catch {
    return fallback;
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // 同じ端末の別のタブでつけ外ししたときも揃える
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
};

const write = (stored: string) => {
  fallback = stored;
  try {
    localStorage.setItem(storageKey, stored);
  } catch {
    // 覚えられなくても、この画面では fallback でつけたタグを使う
  }
  for (const listener of listeners) listener();
};

/** 同じ値を読んだら同じ配列を返す（useSyncExternalStore は読むたびに同じ値を返す必要がある） */
let cache:
  | Readonly<{
      stored: string | null;
      sessionId: SessionId | undefined;
      tags: ReadonlyArray<TagName>;
    }>
  | undefined;

const read = (sessionId: SessionId | undefined): ReadonlyArray<TagName> => {
  const stored = readStored();
  if (cache === undefined || cache.stored !== stored || cache.sessionId !== sessionId) {
    cache = { stored, sessionId, tags: attachedTagsIn(parseAttachedTags(stored), sessionId) };
  }
  return cache.tags;
};

/**
 * 今のセッション `sessionId`（なければ `undefined`）で入力欄につけたままのタグと、それを変える関数。
 *
 * セッションの外でもつけられ、準備したタグとして次に始めるセッションに持ち越す。
 * セッションの中で準備したタグを見たら、このセッションのタグとして覚え直し、セッションが終わったら外れるようにする。
 */
export const useAttachedTags = (
  sessionId: SessionId | undefined,
): readonly [ReadonlyArray<TagName>, (tags: ReadonlyArray<TagName>) => void] => {
  const tags = useSyncExternalStore(subscribe, () => read(sessionId));

  useEffect(() => {
    const attached = parseAttachedTags(readStored());
    if (sessionId !== undefined && attached.kind === "Prepared" && attached.tags.length > 0) {
      write(serializeAttachedTags(attachTags(sessionId, attached.tags)));
    }
  }, [sessionId]);

  return [tags, (next) => write(serializeAttachedTags(attachTags(sessionId, next)))];
};

/**
 * 削除したタグを、この端末でつけたままのタグからも外す（付け替えたなら付け替え先に置き換える、ADR 0017）。
 * 削除したタグをつけていなければ何もしない
 */
export const applyTagDeletionToAttached = (deleted: DeletedTag): void => {
  const stored = readStored();
  const next = serializeAttachedTags(withTagDeleted(parseAttachedTags(stored), deleted));
  if (stored !== null && next !== stored) {
    write(next);
  }
};
