import { APIError } from "better-auth/api";
import { describe, expect, test } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import { Allowlist } from "../domain/allowlist.ts";
import { guardUserCreation } from "./auth.ts";

const allowlistOf = (raw: string) => {
  const parsed = Allowlist.parse(raw);
  if (Result.isFailure(parsed)) {
    throw new Error("テストデータの許可リストを解釈できなかった");
  }
  return parsed.value;
};

/** 拒否されたときのエラーを取り出す。作成できてしまったら undefined。 */
const rejectionOf = async (allowlist: Allowlist, email: string): Promise<unknown> =>
  guardUserCreation(allowlist)({ email }).then(
    () => undefined,
    (error: unknown) => error,
  );

describe("ユーザー作成のガード", () => {
  test("許可リストに載っているメールアドレスなら作成させる", async () => {
    const rejection = await rejectionOf(allowlistOf("me@example.com"), "me@example.com");

    expect(rejection).toBeUndefined();
  });

  test("許可リストに載っていないメールアドレスは作成を拒否する", async () => {
    const rejection = await rejectionOf(allowlistOf("me@example.com"), "someone-else@example.com");

    expect(rejection).toBeInstanceOf(APIError);
  });

  test("拒否したときは画面が理由を出せるよう EMAIL_NOT_ALLOWED を返す", async () => {
    const rejection = await rejectionOf(allowlistOf("me@example.com"), "someone-else@example.com");

    if (!(rejection instanceof APIError)) {
      throw new Error("APIError で拒否されるはず");
    }
    expect(rejection.body?.code).toBe("EMAIL_NOT_ALLOWED");
    expect(rejection.status).toBe("FORBIDDEN");
  });
});
