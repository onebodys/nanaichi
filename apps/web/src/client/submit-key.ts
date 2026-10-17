import type { KeyboardEvent } from "react";

/**
 * Enter で送信し、Shift+Enter で改行する（docs/PRODUCT.md「画面」）。
 * 日本語入力の変換を確定する Enter では送信しない。
 */
export const isSubmitKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean =>
  event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing;
