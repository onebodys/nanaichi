import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, test } from "vite-plus/test";
import { schemaResult } from "./schema-result.ts";

describe("スキーマ検証の Result への変換", () => {
  test("非同期に検証するスキーマは、同期でなければならないと例外で知らせる", () => {
    const asyncSchema: StandardSchemaV1<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => Promise.resolve({ value: 1 }),
      },
    };

    expect(() => schemaResult(asyncSchema)("anything")).toThrow(
      new TypeError("スキーマ検証は同期でなければならない"),
    );
  });
});
