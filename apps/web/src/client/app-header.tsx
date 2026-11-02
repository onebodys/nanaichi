import { ChartColumnIcon, SettingsIcon } from "lucide-react";
import { signOut } from "./auth-client.ts";
import { Button } from "./components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
import { todayFocusOf, type TodayFocus } from "./focus-time-text.ts";
import { LogoMark } from "./logo-mark.tsx";
import { useRecordStore } from "./record-store.ts";

/** アカウントのメニュー。名前の頭文字のボタンから開き、ログアウトできる */
const AccountMenu = ({ name }: Readonly<{ name: string }>) => {
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

/** 記録先がこの端末のあいだ出す。ログインすると同期でき、この端末の記録を引き継ぐ導線になる（ADR 0019） */
const SignInLink = () => (
  <Button
    variant="outline"
    size="lg"
    className="rounded-[10px]"
    nativeButton={false}
    render={<a href="/login" />}
  >
    ログインして同期
  </Button>
);

/** 記録先ごとのヘッダー右端。アカウントなら名前のメニュー、この端末ならログインへの入口 */
const AccountEntry = () => {
  const recordStore = useRecordStore();
  switch (recordStore.kind) {
    case "Device":
      return <SignInLink />;
    case "Account":
      return <AccountMenu name={recordStore.user.name} />;
  }
};

/**
 * 今日の集中時間（GLOSSARY の「集中時間」）。続けるはげみにするため、いつも見える場所に出す。
 * PC は集中時間とセット数、スマホは短く `今日 1時間24分` にする（`1:24` は時刻と見分けにくい）。数が確定するまでは「—」
 */
const TodayFocusBadge = ({ today }: Readonly<{ today: TodayFocus }>) => {
  const focus = todayFocusOf(today);
  const value = (text: string) => (
    <span className="font-mono font-medium text-foreground">{text}</span>
  );
  return (
    <p className="text-xs text-muted-foreground">
      <span className="flex items-baseline gap-1.5 lg:hidden">
        今日 {value(focus.kind === "Counted" ? focus.label : "—")}
      </span>
      <span className="hidden items-baseline gap-2 rounded-full bg-muted px-3.5 py-2 lg:flex">
        今日の集中
        <span className="text-[15px]">{value(focus.kind === "Counted" ? focus.label : "—")}</span>
        {focus.kind === "Counted" && <span>{focus.sets}</span>}
      </span>
    </p>
  );
};

/**
 * 画面上部のヘッダー（Issue #34 の A 案）。左にロゴ、右に今日の集中時間、スタッツと設定画面を開くボタン、アカウントのメニュー（この端末のあいだはログインへの入口）。
 */
export const AppHeader = ({
  today,
  openStats,
  openSettings,
}: Readonly<{ today: TodayFocus; openStats: () => void; openSettings: () => void }>) => (
  <header className="shrink-0 border-b bg-card">
    {/* 広い画面では中身をタイマーとジャーナルの2ペインと同じ幅にそろえる（home-page.tsx） */}
    <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center justify-between gap-4 px-4 lg:h-16 lg:px-8">
      <div className="flex items-center gap-2.5">
        <LogoMark className="size-7 rounded-lg text-xs" />
        <h1 className="text-lg font-bold tracking-tight">nanaichi</h1>
      </div>
      <div className="flex items-center gap-2 lg:gap-3">
        <TodayFocusBadge today={today} />
        <Button
          variant="outline"
          size="icon-lg"
          className="rounded-[10px]"
          aria-label="スタッツ"
          onClick={openStats}
        >
          <ChartColumnIcon className="size-[18px]" />
        </Button>
        <Button
          variant="outline"
          size="icon-lg"
          className="rounded-[10px]"
          aria-label="設定"
          onClick={openSettings}
        >
          <SettingsIcon className="size-[18px]" />
        </Button>
        <AccountEntry />
      </div>
    </div>
  </header>
);
