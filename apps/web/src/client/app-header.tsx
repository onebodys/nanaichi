import { AlertSettingsPanel } from "./alert-settings-panel.tsx";
import { authClient } from "./auth-client.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
import type { PhaseAlert } from "./phase-alert.ts";

const signOut = async () => {
  await authClient.signOut();
  // ログアウト後はセッションが無くなるので、ルートの beforeLoad がログイン画面へ送る
  window.location.href = "/login";
};

/** アカウントのメニュー。名前の頭文字のボタンから開き、ログアウトできる */
const AccountMenu = () => {
  const { data: session, isPending } = authClient.useSession();
  if (isPending || session === null) {
    return <p className="text-sm text-muted-foreground">読み込み中…</p>;
  }
  const { name } = session.user;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="アカウント"
        className="flex size-9 items-center justify-center rounded-full bg-muted font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {name.slice(0, 1)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{name} としてログインしています</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()}>ログアウト</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * 画面上部のヘッダー（Issue #34 の A 案）。左にロゴ、右に音と通知の設定とアカウントのメニュー。
 * 「7·1」は集中7分とジャーナル1分のマーク。
 */
export const AppHeader = ({ phaseAlert }: Readonly<{ phaseAlert: PhaseAlert }>) => (
  <header className="shrink-0 border-b bg-card">
    {/* 広い画面では中身をタイマーとジャーナルの2ペインと同じ幅にそろえる（home-page.tsx） */}
    <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center justify-between gap-4 px-4 lg:h-16 lg:px-8">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-lg bg-primary font-mono text-xs font-medium text-primary-foreground"
        >
          7·1
        </span>
        <h1 className="text-lg font-bold tracking-tight">nanaichi</h1>
      </div>
      <div className="flex items-center gap-2 lg:gap-3">
        <AlertSettingsPanel phaseAlert={phaseAlert} />
        <AccountMenu />
      </div>
    </div>
  </header>
);
