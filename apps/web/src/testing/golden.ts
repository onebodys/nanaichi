import { Result } from "@praha/byethrow";
import { describe, expect, test } from "vite-plus/test";
import type * as v from "valibot";
import type { Sensitive } from "../domain/sensitive.ts";

/**
 * TS と Swift のドメインが同じ振る舞いをすることを確かめるための場面（ADR 0015）。
 * 期待する出力は実装から作らず、仕様として手で書く。
 */
export type GoldenCase<I, O> = Readonly<{ name: string; input: I; expected: Plain<O> }>;

/** 出力の型は `run` の返り値だけから決める（期待する出力の書き方から型を推論させない） */
type FromRun<T> = [T][T extends unknown ? 0 : never];

/**
 * 出力の型から、ブランドと `Sensitive` を外した型。期待する出力は JSON に書く形の素の値で書く
 * （ID やタグの名前をブランドを付ける関数に通さずに書ける）
 */
export type Plain<T> =
  T extends Sensitive<infer U>
    ? Plain<U>
    : T extends string
      ? T extends v.Brand<string>
        ? string
        : T
      : T extends Date
        ? Date
        : T extends ReadonlyArray<infer E>
          ? ReadonlyArray<Plain<E>>
          : T extends object
            ? { readonly [K in keyof T]: Plain<T[K]> }
            : T;

/** byethrow の Result を、Swift からも読める `kind` の判別子にした形 */
export type Settled<T, E> =
  | Readonly<{ kind: "Success"; value: T }>
  | Readonly<{ kind: "Failure"; error: E }>;

export const settled = <T, E>(result: Result.Result<T, E>): Settled<T, E> =>
  Result.isSuccess(result)
    ? { kind: "Success", value: result.value }
    : { kind: "Failure", error: result.error };

const GOLDEN_DIR = decodeURIComponent(
  new URL("../../../../fixtures/golden/", import.meta.url).pathname,
);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isSensitive = (value: unknown): value is Readonly<{ unwrap: () => unknown }> =>
  isRecord(value) && typeof value["unwrap"] === "function";

/**
 * JSON にできる値に変える。時刻は ISO 8601 の文字列にする。
 * `Sensitive` は `toJSON` で伏せられるので、先に中身を取り出す（ゴールデンケースの本文は作った文で、PII ではない）
 */
const toGoldenJson = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (isSensitive(value)) return toGoldenJson(value.unwrap());
  if (Array.isArray(value)) return value.map(toGoldenJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field !== undefined)
        .map(([key, field]) => [key, toGoldenJson(field)]),
    );
  }
  return value;
};

/**
 * 出力は JSON にした形で比べる（`Sensitive` の本文は関数なので、そのままでは比べられない）。
 * 場面を TS の実装に通し、同じ場面を `fixtures/golden/<name>.json` に書き出す。
 * 場面を変えて JSON を書き出し直していなければ落ちる（`vp test -u` で書き出し直す）。Swift はこの JSON を通す
 */
export const goldenCases = <I, O>(
  name: string,
  run: (input: I) => O,
  cases: ReadonlyArray<GoldenCase<I, FromRun<O>>>,
): void => {
  describe(name, () => {
    test.each(cases)("$name", ({ input, expected }) => {
      expect(toGoldenJson(run(input))).toEqual(toGoldenJson(expected));
    });

    test("ゴールデンケースの JSON が場面と一致する", async () => {
      const json = `${JSON.stringify(toGoldenJson({ function: name, cases }), null, 2)}\n`;
      await expect(json).toMatchFileSnapshot(`${GOLDEN_DIR}${name}.json`);
    });
  });
};
