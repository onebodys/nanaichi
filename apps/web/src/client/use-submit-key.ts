import { useSyncExternalStore } from "react";
import * as v from "valibot";
import { defaultSubmitKey, SubmitKeySchema, type SubmitKey } from "./submit-key.ts";

/**
 * 送信キーの設定を端末ごとに覚える（GLOSSARY.md「送信キー」）。
 *
 * localStorage は使えないこと（プライベートブラウズ・サイトデータのブロック）もあるので、
 * 読み書きに失敗したら既定の送信キーで動き続ける。
 */
const storageKey = "nanaichi:submit-key";

const listeners = new Set<() => void>();
/** localStorage に書けなかったときも、開いている画面の中では選んだ送信キーを使う */
let fallback: SubmitKey = defaultSubmitKey;

const read = (): SubmitKey => {
  try {
    const parsed = v.safeParse(SubmitKeySchema, localStorage.getItem(storageKey));
    return parsed.success ? parsed.output : fallback;
  } catch {
    return fallback;
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // 別のタブで選び直したときも揃える
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
};

const write = (submitKey: SubmitKey) => {
  fallback = submitKey;
  try {
    localStorage.setItem(storageKey, submitKey);
  } catch {
    // 覚えられなくても、この画面では fallback で選んだ送信キーを使う
  }
  for (const listener of listeners) listener();
};

export const useSubmitKey = (): readonly [SubmitKey, (submitKey: SubmitKey) => void] => [
  useSyncExternalStore(subscribe, read),
  write,
];
