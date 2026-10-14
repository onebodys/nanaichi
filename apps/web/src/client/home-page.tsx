import { authClient } from "./auth-client.ts";

export const HomePage = () => {
  const { data: session, isPending } = authClient.useSession();

  const signOut = async () => {
    await authClient.signOut();
    // ログアウト後はセッションが無くなるので、ルートの beforeLoad がログイン画面へ送る
    window.location.href = "/login";
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6">
      <h1 className="text-4xl font-bold tracking-tight">nanaichi</h1>

      {isPending ? (
        <p className="text-sm text-neutral-500">読み込み中…</p>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-neutral-600">{session?.user.name} としてログインしています</p>
          <button
            type="button"
            onClick={signOut}
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium transition hover:bg-neutral-50"
          >
            ログアウト
          </button>
        </div>
      )}

      <p className="text-sm text-neutral-400">タイマーは M2 以降で作ります</p>
    </main>
  );
};
