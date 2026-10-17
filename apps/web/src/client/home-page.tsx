import { authClient } from "./auth-client.ts";
import { Button } from "./components/ui/button.tsx";
import { TimerPanel } from "./timer-panel.tsx";

export const HomePage = () => {
  const { data: session, isPending } = authClient.useSession();

  const signOut = async () => {
    await authClient.signOut();
    // ログアウト後はセッションが無くなるので、ルートの beforeLoad がログイン画面へ送る
    window.location.href = "/login";
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-10 px-6 py-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-bold tracking-tight">nanaichi</h1>
        {isPending || session === null ? (
          <p className="text-sm text-muted-foreground">読み込み中…</p>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground">
              {session.user.name} としてログインしています
            </p>
            <Button variant="outline" size="sm" onClick={signOut}>
              ログアウト
            </Button>
          </div>
        )}
      </header>

      <TimerPanel />
    </main>
  );
};
