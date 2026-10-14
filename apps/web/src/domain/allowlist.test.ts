import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import { Allowlist } from "./allowlist.ts";

const allowlistOf = (raw: string) => {
  const parsed = Allowlist.parse(raw);
  if (Result.isFailure(parsed)) {
    throw new Error("テストデータの許可リストを解釈できなかった");
  }
  return parsed.value;
};

describe("許可リスト", () => {
  test("カンマ区切りで複数のメールアドレスを指定できる", () => {
    const allowlist = allowlistOf("me@example.com, you@example.com");

    expect(allowlist).toHaveLength(2);
  });

  test("前後の空白や空の項目は無視する", () => {
    const allowlist = allowlistOf(" me@example.com ,, you@example.com , ");

    expect(allowlist).toHaveLength(2);
  });

  test("許可リストが空なら誰も登録できない", () => {
    const allowlist = allowlistOf("");

    expect(Allowlist.permits(allowlist, "me@example.com")).toBe(false);
  });
});

describe("登録の可否", () => {
  test("許可リストに載っているメールアドレスは登録を許可する", () => {
    const allowlist = allowlistOf("me@example.com");

    expect(Allowlist.permits(allowlist, "me@example.com")).toBe(true);
  });

  test("許可リストに載っていないメールアドレスは登録を拒否する", () => {
    const allowlist = allowlistOf("me@example.com");

    expect(Allowlist.permits(allowlist, "someone-else@example.com")).toBe(false);
  });

  test("大文字小文字が違っても同じメールアドレスとして許可する", () => {
    const allowlist = allowlistOf("Me@Example.com");

    expect(Allowlist.permits(allowlist, "mE@eXaMpLe.CoM")).toBe(true);
  });

  test("前後に空白があっても同じメールアドレスとして許可する", () => {
    const allowlist = allowlistOf("me@example.com");

    expect(Allowlist.permits(allowlist, "  me@example.com  ")).toBe(true);
  });

  test("メールアドレスとして解釈できない値は登録を拒否する", () => {
    const allowlist = allowlistOf("me@example.com");

    expect(Allowlist.permits(allowlist, "not-an-email")).toBe(false);
    expect(Allowlist.permits(allowlist, "")).toBe(false);
    expect(Allowlist.permits(allowlist, undefined)).toBe(false);
    expect(Allowlist.permits(allowlist, 42)).toBe(false);
  });

  test("接尾辞が一致するだけの別のメールアドレスは拒否する", () => {
    const allowlist = allowlistOf("me@example.com");

    expect(Allowlist.permits(allowlist, "me@example.com.evil.test")).toBe(false);
    expect(Allowlist.permits(allowlist, "notme@example.com")).toBe(false);
  });
});
