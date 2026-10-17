import { describe, expect, test } from "vite-plus/test";
import * as v from "valibot";
import { SensitiveEmailSchema } from "./email.ts";
import { Sensitive } from "./sensitive.ts";

describe("Sensitive", () => {
  test("unwrap すると元の値を取り出せる", () => {
    const sensitive = Sensitive.of("me@example.com");

    expect(sensitive.unwrap()).toBe("me@example.com");
  });

  test("JSON にすると伏せられる", () => {
    const sensitive = Sensitive.of("me@example.com");

    expect(JSON.stringify({ email: sensitive })).toBe('{"email":"[REDACTED]"}');
  });

  test("文字列として扱っても伏せられる", () => {
    const sensitive = Sensitive.of("me@example.com");

    expect(String(sensitive)).toBe("[REDACTED]");
  });

  test("メールアドレスのスキーマを通すと自動的に包まれる", () => {
    const parsed = v.parse(SensitiveEmailSchema, "me@example.com");

    expect(JSON.stringify(parsed)).toBe('"[REDACTED]"');
    expect(parsed.unwrap()).toBe("me@example.com");
  });
});
