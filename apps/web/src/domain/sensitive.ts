/**
 * 個人情報（メールアドレスなど）を包む型。
 *
 * TypeScript の型は実行時に消えるため、型で PII と印を付けても `console.log` や
 * `JSON.stringify` からの漏洩は防げない。値そのものをクロージャに閉じ込め、
 * 直列化の入口（`toJSON` / `toString` / Node の inspect）で伏せることで、
 * うっかりログに出すことを防ぐ（AGENTS.md「境界での検証と PII」）。
 */
export type Sensitive<T> = Readonly<{
  unwrap: () => T;
  toJSON: () => string;
  toString: () => string;
}>;

const REDACTED = "[REDACTED]";

export const Sensitive = {
  of: <T>(value: T): Sensitive<T> => ({
    unwrap: () => value,
    toJSON: () => REDACTED,
    toString: () => REDACTED,
    [Symbol.for("nodejs.util.inspect.custom")]: () => REDACTED,
  }),
} as const;
