import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { ApiErrorBodyJsonSchema } from "./api-error.ts";

describe("API のエラーの応答の本文", () => {
  test.each(["WEBSOCKET_UPGRADE_REQUIRED", "CROSS_ORIGIN_REJECTED", "RATE_LIMITED"])(
    "同期の接続や呼び出しの回数で断られたときの種類 %s を読める",
    (error) => {
      const parsed = v.safeParse(ApiErrorBodyJsonSchema, { error, operation: "ignored" });

      expect(parsed.success && parsed.output.error).toBe(error);
    },
  );

  test("知らない種類や空の種類は応答の形が違うものとして断る", () => {
    expect(v.safeParse(ApiErrorBodyJsonSchema, { error: "" }).success).toBe(false);
    expect(v.safeParse(ApiErrorBodyJsonSchema, { error: "SOMETHING_ELSE" }).success).toBe(false);
  });
});
