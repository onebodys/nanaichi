import { Button } from "./components/ui/button.tsx";
import { LogoMark } from "./logo-mark.tsx";

/**
 * ログインしているかを確かめられなかったときの画面。この端末の記録に倒すと、ログイン中の人の記録が分かれてしまうので、
 * 確かめ直してもらう（ADR 0019）
 */
export const RecordStoreUnknownPage = () => (
  <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-12 text-foreground">
    <LogoMark className="size-14 rounded-2xl text-lg" />
    <div className="flex flex-col items-center gap-2 text-center">
      <h1 className="text-xl font-bold">ログインの状態を確かめられませんでした</h1>
      <p className="text-sm text-muted-foreground">
        通信できていないかもしれません。接続を確かめて、もう一度読み込んでください。
      </p>
    </div>
    <Button onClick={() => window.location.reload()}>再読み込み</Button>
  </main>
);
