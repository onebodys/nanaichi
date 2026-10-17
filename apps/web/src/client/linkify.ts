/**
 * 記入の本文を、表示するときの断片に分ける（docs/PRODUCT.md「ジャーナル記入」）。
 *
 * 本文はプレーンテキストとして表示し、`http://` と `https://` で始まる URL だけをリンクにする。
 * Markdown などの記法は解釈しない。
 */
export type TextSegment =
  | Readonly<{ kind: "Text"; text: string }>
  | Readonly<{ kind: "Link"; href: string }>;

/** 空白・改行と、URL の外側にあることの多い全角の文字までを URL とみなす */
const URL_PATTERN = /https?:\/\/[^\s<>"'`、。「」『』（）]+/gu;

/** URL の末尾に付いた句読点や閉じかっこは、文の一部として URL から外す */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/u;

export const linkify = (text: string): ReadonlyArray<TextSegment> => {
  const segments: Array<TextSegment> = [];
  let rest = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const href = match[0].replace(TRAILING_PUNCTUATION, "");
    if (match.index > rest) {
      segments.push({ kind: "Text", text: text.slice(rest, match.index) });
    }
    segments.push({ kind: "Link", href });
    rest = match.index + href.length;
  }
  if (rest < text.length) {
    segments.push({ kind: "Text", text: text.slice(rest) });
  }
  return segments;
};
