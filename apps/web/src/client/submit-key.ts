import type { KeyboardEvent } from "react";
import * as v from "valibot";

/**
 * 送信キー（GLOSSARY.md）。
 *
 * - `ModifierEnter`: Enter で改行し、⌘+Enter（Mac 以外は Ctrl+Enter）で送る。既定
 * - `Enter`: Enter で送り、Shift+Enter で改行する
 */
export const SubmitKeySchema = v.picklist(["ModifierEnter", "Enter"]);
export type SubmitKey = v.InferOutput<typeof SubmitKeySchema>;

export const defaultSubmitKey: SubmitKey = "ModifierEnter";

/** 送るかどうかの判断に使うキー入力の情報 */
type KeyPress = Readonly<{
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** 日本語入力の変換中か */
  isComposing: boolean;
}>;

/**
 * このキー入力で送るか。どちらの送信キーでも、変換を確定する Enter では送らない。
 *
 * 修飾キーは ⌘ と Ctrl のどちらでも送る。Mac で Ctrl+Enter、Windows で Win+Enter を押しても
 * 改行にしかならず困らないので、端末の判定には頼らない。
 */
export const shouldSubmit = (submitKey: SubmitKey, press: KeyPress): boolean => {
  if (press.key !== "Enter" || press.isComposing || press.shiftKey) {
    return false;
  }
  switch (submitKey) {
    case "ModifierEnter":
      return press.metaKey || press.ctrlKey;
    case "Enter":
      return true;
  }
};

export const isSubmitKey = (
  submitKey: SubmitKey,
  event: KeyboardEvent<HTMLTextAreaElement>,
): boolean =>
  shouldSubmit(submitKey, {
    key: event.key,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    isComposing: event.nativeEvent.isComposing,
  });

/** 修飾キーの表記。Apple の端末は ⌘、それ以外は Ctrl */
export const modifierLabelOf = (userAgent: string): string =>
  /Mac|iPhone|iPad/.test(userAgent) ? "⌘" : "Ctrl";

/** 送信キーを選ぶ欄に出す、送り方の表記 */
export const submitKeyLabelOf = (submitKey: SubmitKey, modifierLabel: string): string => {
  switch (submitKey) {
    case "ModifierEnter":
      return `${modifierLabel}+Enter で送信`;
    case "Enter":
      return "Enter で送信";
  }
};

/** 入力欄のプレースホルダーに添える、送り方と改行のしかた */
export const submitKeyHintOf = (submitKey: SubmitKey, modifierLabel: string): string => {
  switch (submitKey) {
    case "ModifierEnter":
      return `${modifierLabel}+Enter で送信、Enter で改行`;
    case "Enter":
      return "Enter で送信、Shift+Enter で改行";
  }
};
