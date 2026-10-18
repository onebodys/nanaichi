import { useState } from "react";
import { authClient } from "./auth-client.ts";

/**
 * Better Auth が `?error=` に載せて戻すコードの日本語メッセージ。
 * 未知のコードはサーバー側の文言をそのまま出さず、一般的な失敗として扱う。
 * `?error=` は外から自由に付けられるので、`constructor` などのプロトタイプのキーに
 * 当たらないよう Record ではなく Map で引く。
 */
const ERROR_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["EMAIL_NOT_ALLOWED", "このメールアドレスでは登録できません。"],
]);

type LoginPageProps = Readonly<{
  /** URL の `?error=`。Better Auth がログイン失敗時に付けて戻す */
  error: string | undefined;
}>;

export const LoginPage = ({ error }: LoginPageProps) => {
  const [isRedirecting, setIsRedirecting] = useState(false);
  const errorMessage =
    error === undefined ? undefined : (ERROR_MESSAGES.get(error) ?? "ログインできませんでした。");

  const signInWithGoogle = async () => {
    setIsRedirecting(true);
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
      errorCallbackURL: "/login",
    });
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-4xl font-bold tracking-tight">nanaichi</h1>
        <p className="text-sm text-neutral-500">7分の集中と1分のジャーナルを繰り返す</p>
      </div>

      <div className="flex w-full max-w-xs flex-col gap-3">
        <button
          type="button"
          onClick={signInWithGoogle}
          disabled={isRedirecting}
          className="rounded-lg border border-neutral-300 px-4 py-3 text-sm font-medium transition hover:bg-neutral-50 disabled:opacity-50"
        >
          {isRedirecting ? "Google へ移動しています…" : "Google でログイン"}
        </button>

        {errorMessage !== undefined && (
          <p role="alert" className="text-center text-sm text-red-600">
            {errorMessage}
          </p>
        )}
      </div>

      {import.meta.env.DEV && <TestSignInForm />}
    </main>
  );
};

/**
 * テスト用のログイン（`/api/test/sign-in`、ADR 0008）の入口。開発サーバー（`vp dev`）でだけ描画し、
 * 本番のビルドには入らない。
 *
 * portless の `*.localhost` は Google のリダイレクト URI に登録できず Google のログインが通らないので、
 * 人間はここから許可リストのメールアドレスでログインする。サーバー側で `TEST_SIGN_IN=enabled` が
 * なければ 404 になる。
 */
const TestSignInForm = () => (
  <form
    action="/api/test/sign-in"
    method="get"
    className="flex w-full max-w-xs flex-col gap-2 rounded-lg border border-dashed border-neutral-300 p-3"
  >
    <label htmlFor="test-sign-in-email" className="text-xs text-neutral-500">
      開発用ログインのメールアドレス
    </label>
    <p id="test-sign-in-email-hint" className="text-xs text-neutral-500">
      Google を通さない。許可リストに載せたもの
    </p>
    <div className="flex gap-2">
      <input
        id="test-sign-in-email"
        aria-describedby="test-sign-in-email-hint"
        name="email"
        type="email"
        required
        className="min-w-0 flex-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
      />
      <button
        type="submit"
        className="rounded-md border border-neutral-300 px-3 py-1 text-sm transition hover:bg-neutral-50"
      >
        開発用ログイン
      </button>
    </div>
  </form>
);
