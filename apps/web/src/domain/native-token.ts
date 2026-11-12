import * as v from "valibot";

/**
 * `POST /api/native-auth/token` の応答（ADR 0029）。ネイティブアプリはこの `token` を Keychain に置き、
 * `Authorization: Bearer <token>` で `/api/*` と `GET /api/ws` を呼ぶ。読むのは Swift のアプリで、
 * ここのスキーマは結合テストが応答の形を確かめるのに使う。
 */
export const NativeTokenJsonSchema = v.object({ token: v.pipe(v.string(), v.nonEmpty()) });

export type NativeToken = v.InferOutput<typeof NativeTokenJsonSchema>;
