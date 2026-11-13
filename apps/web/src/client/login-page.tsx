import { useEffect, useState } from "react";
import { Result } from "@praha/byethrow";
import { authClient } from "./auth-client.ts";
import { LinkButton } from "./components/ui/button.tsx";
import { LogoMark } from "./logo-mark.tsx";

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

/**
 * この端末で開いたままのセッションがあるか。取り込めるのは閉じたセッションだけで（ADR 0020）、
 * ログインするとこの端末の記録先では操作できなくなるので、開いていればログインさせない。
 * 読めなければ止めない（取り込みのときに、読めなかったと知らせる）
 */
type DeviceSessionCheck =
  | Readonly<{ kind: "Checking" }>
  | Readonly<{ kind: "SessionOpen" }>
  | Readonly<{ kind: "Clear" }>;

const checkDeviceSession = async (): Promise<DeviceSessionCheck> => {
  const { openBrowserDeviceImport } = await import("../device/index.ts");
  const loaded = await openBrowserDeviceImport().load();
  return Result.isSuccess(loaded) && loaded.value.open.kind === "OpenSessionLeft"
    ? { kind: "SessionOpen" }
    : { kind: "Clear" };
};

export const LoginPage = ({ error }: LoginPageProps) => {
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [deviceSession, setDeviceSession] = useState<DeviceSessionCheck>({ kind: "Checking" });
  useEffect(() => {
    void checkDeviceSession().then(setDeviceSession);
  }, []);
  const errorMessage =
    error === undefined ? undefined : (ERROR_MESSAGES.get(error) ?? "ログインできませんでした。");

  const signInWithGoogle = async () => {
    setIsRedirecting(true);
    await authClient.signIn.social({
      provider: "google",
      // ログインした直後だとホーム画面に知らせ、この端末の記録を取り込むかを尋ねる（ADR 0020）
      callbackURL: "/?from=login",
      errorCallbackURL: "/login",
    });
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12 text-foreground">
      <div className="flex w-full max-w-sm flex-col items-center gap-10">
        <div className="flex flex-col items-center gap-4">
          <LogoMark className="size-14 rounded-2xl text-lg" />
          <div className="flex flex-col items-center gap-1.5">
            <h1 className="text-3xl font-bold tracking-tight">nanaichi</h1>
            <p className="text-sm text-muted-foreground">7分の集中と1分のジャーナルを繰り返す</p>
          </div>
        </div>

        <RoundPreview />

        {deviceSession.kind === "SessionOpen" ? (
          <div
            role="alert"
            className="flex w-full flex-col items-center gap-4 rounded-2xl border bg-card p-5 text-center shadow-xs"
          >
            <p className="text-[15px] font-medium">セッションを終えてからログインしてください</p>
            <p className="text-sm text-muted-foreground">
              この端末で開いたままのセッションがあります。ログインすると、この端末の記録のうち終えたセッションをアカウントに取り込めます。
            </p>
            <LinkButton href="/" variant="outline">
              ホームに戻る
            </LinkButton>
          </div>
        ) : (
          <div className="flex w-full flex-col gap-3 rounded-2xl border bg-card p-5 shadow-xs">
            <button
              type="button"
              onClick={signInWithGoogle}
              disabled={isRedirecting || deviceSession.kind === "Checking"}
              className="flex h-12 items-center justify-center gap-3 rounded-xl border bg-background text-[15px] font-medium transition outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            >
              <GoogleIcon />
              {isRedirecting ? "Google へ移動しています…" : "Google でログイン"}
            </button>

            {errorMessage !== undefined && (
              <p role="alert" className="text-center text-sm text-destructive">
                {errorMessage}
              </p>
            )}
          </div>
        )}

        {import.meta.env.DEV && deviceSession.kind === "Clear" && <TestSignInForm />}
      </div>
    </main>
  );
};

/**
 * 1ラウンドの流れ（集中7分 + ジャーナル1分を3セット、そのあと休憩5分）を、長さに比例した帯で見せる。
 * 色はタイマーと同じフェーズの色。数字は固定の仕様（docs/PRODUCT.md）をそのまま描いている
 */
const RoundPreview = () => (
  <figure className="flex w-full flex-col gap-3">
    <div aria-hidden className="flex h-2 w-full gap-1">
      {[1, 2, 3].map((set) => (
        <span key={set} className="contents">
          <span className="grow-7 rounded-full bg-focus-mark" />
          <span className="grow rounded-full bg-journal-mark" />
        </span>
      ))}
      <span className="grow-5 rounded-full bg-break-mark" />
    </div>
    <figcaption className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <PhaseLegend className="bg-focus-mark" label="集中 7分" />
      <PhaseLegend className="bg-journal-mark" label="ジャーナル 1分" />
      <PhaseLegend className="bg-break-mark" label="3セットごとに休憩 5分" />
    </figcaption>
  </figure>
);

const PhaseLegend = ({ className, label }: Readonly<{ className: string; label: string }>) => (
  <span className="flex items-center gap-1.5">
    <span aria-hidden className={`size-2 rounded-full ${className}`} />
    {label}
  </span>
);

/** Google のロゴ（Google のログインボタンの指針どおり、色は変えない） */
const GoogleIcon = () => (
  <svg aria-hidden width="18" height="18" viewBox="0 0 48 48">
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
  </svg>
);

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
    className="flex w-full flex-col gap-2 rounded-xl border border-dashed p-3"
  >
    <label htmlFor="test-sign-in-email" className="text-xs text-muted-foreground">
      開発用ログインのメールアドレス
    </label>
    <p id="test-sign-in-email-hint" className="text-xs text-muted-foreground">
      Google を通さない。許可リストに載せたもの
    </p>
    <div className="flex gap-2">
      <input
        id="test-sign-in-email"
        aria-describedby="test-sign-in-email-hint"
        name="email"
        type="email"
        required
        className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
      />
      <button
        type="submit"
        className="rounded-md border bg-background px-3 py-1 text-sm transition hover:bg-muted"
      >
        開発用ログイン
      </button>
    </div>
  </form>
);
