import { useSyncExternalStore } from "react";
import type { SessionId } from "../domain/session.ts";
import type { TagName } from "../domain/tag.ts";
import { attachedTagsOf, serializeAttachedTags } from "./attached-tags.ts";

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
  | Readonly<{ stored: string | null; sessionId: SessionId; tags: ReadonlyArray<TagName> }>
  | undefined;
const NO_TAGS: ReadonlyArray<TagName> = [];

const read = (sessionId: SessionId | undefined): ReadonlyArray<TagName> => {
  if (sessionId === undefined) {
    return NO_TAGS;
  }
  const stored = readStored();
  if (cache?.stored !== stored || cache.sessionId !== sessionId) {
    cache = { stored, sessionId, tags: attachedTagsOf(stored, sessionId) };
  }
  return cache.tags;
};

/**
 * セッション `sessionId` で入力欄につけたままのタグと、それを変える関数。
 * セッションがなければ（終了したあとも）タグはついておらず、つけられない。
 */
export const useAttachedTags = (
  sessionId: SessionId | undefined,
): readonly [ReadonlyArray<TagName>, (tags: ReadonlyArray<TagName>) => void] => [
  useSyncExternalStore(subscribe, () => read(sessionId)),
  (tags) => {
    if (sessionId !== undefined) {
      write(serializeAttachedTags({ sessionId, tags }));
    }
  },
];
