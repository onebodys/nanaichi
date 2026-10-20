/**
 * 連携の許可の画面（GLOSSARY「連携の許可」）に出す文言。
 *
 * MCP クライアントが求める範囲（scope）を、ユーザーが読んで選べる言葉にする。
 * 知らない範囲は隠さず、名前のまま出す（何を許すかを見落とさないように）。
 */
const SCOPE_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  ["journal:read", "ジャーナル記入（本文とタグ）・スタッツ・タグを読む"],
  ["offline_access", "ログインし直さずに読み続ける（最長30日）"],
  ["openid", "nanaichi のアカウントを見分ける"],
]);

/** 連携の許可の画面の URL の `scope`（空白区切り）を、出す順の説明にする */
export const scopeDescriptionsOf = (scope: string | undefined): ReadonlyArray<string> =>
  (scope ?? "")
    .split(" ")
    .filter((name) => name !== "")
    .map((name) => SCOPE_DESCRIPTIONS.get(name) ?? `不明な範囲（${name}）`);

/**
 * 許可したあとに戻る先。MCP クライアントが自分で登録した名前は自称でしかないので、
 * 実際に戻る先のホストもあわせて出し、知らないところへ渡さないか確かめられるようにする
 */
export const redirectHostOf = (redirectUri: string | undefined): string | undefined => {
  if (redirectUri === undefined || !URL.canParse(redirectUri)) {
    return undefined;
  }
  const url = new URL(redirectUri);
  return url.protocol === "http:" || url.protocol === "https:" ? url.host : url.protocol;
};
