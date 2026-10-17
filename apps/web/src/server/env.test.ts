import { describe, expect, test } from "vite-plus/test";
import type { ValidationError } from "../domain/schema-result.ts";
import { describeValidationError } from "./env.ts";

/** valibot は検証に失敗した値を message に載せてくる。それがログに出ないことを確かめる。 */
const errorFor = (path: string, leakedValue: string): ValidationError => ({
  kind: "ValidationError",
  issues: [{ message: `Invalid length: Received "${leakedValue}"`, path: [path] }],
});

describe("設定エラーの説明", () => {
  test("どの項目が不正かを示す", () => {
    const described = describeValidationError(errorFor("BETTER_AUTH_SECRET", "short"));

    expect(described).toContain("BETTER_AUTH_SECRET");
  });

  test("直し方を示す", () => {
    const described = describeValidationError(errorFor("BETTER_AUTH_SECRET", "short"));

    expect(described).toContain("pnpm cf secret put BETTER_AUTH_SECRET");
  });

  test("秘密の値そのものは出さない", () => {
    const described = describeValidationError(errorFor("BETTER_AUTH_SECRET", "super-secret-value"));

    expect(described).not.toContain("super-secret-value");
  });

  test("メールアドレス（PII）も出さない", () => {
    const described = describeValidationError(errorFor("ALLOWED_EMAILS", "me@example.com"));

    expect(described).not.toContain("me@example.com");
    expect(described).toContain("ALLOWED_EMAILS");
  });
});
