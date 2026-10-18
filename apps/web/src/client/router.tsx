import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import * as v from "valibot";
import { STATS_PERIODS } from "../domain/stats.ts";
import { authClient } from "./auth-client.ts";
import { HomePage } from "./home-page.tsx";
import { LoginPage } from "./login-page.tsx";

const rootRoute = createRootRoute({ component: Outlet });

/** Better Auth がログイン失敗時に付けて戻す `?error=`。外から来る値なのでスキーマで検証する */
const LoginSearchSchema = v.object({ error: v.optional(v.string()) });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search) => {
    const parsed = v.safeParse(LoginSearchSchema, search);
    return parsed.success ? parsed.output : {};
  },
  component: () => {
    const { error } = loginRoute.useSearch();
    return <LoginPage error={error} />;
  },
});

/**
 * 設定画面・スタッツを重ねて開いているか（`?settings=open`、`?stats=<期間>`）。ホーム画面の上に重ねるだけなので、
 * 別のルートにはしない（ルートを移るとホーム画面が外れ、タイマーと知らせが止まる）。外から来る値なのでスキーマで検証する
 */
const HomeSearchSchema = v.object({
  settings: v.optional(v.literal("open")),
  stats: v.optional(v.picklist(STATS_PERIODS)),
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search) => {
    const parsed = v.safeParse(HomeSearchSchema, search);
    return parsed.success ? parsed.output : {};
  },
  // 画面の出し分けだけを行う。実際の保護はサーバー側の /api/* ミドルウェア。
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (data === null) {
      throw redirect({ to: "/login" });
    }
  },
  component: () => {
    const { settings, stats } = homeRoute.useSearch();
    const navigate = homeRoute.useNavigate();
    // 閉じた画面に戻るで戻らないよう、履歴を置き換える
    const close = () => void navigate({ search: {}, replace: true });
    return (
      <HomePage
        settings={{
          open: settings === "open",
          show: () => void navigate({ search: { settings: "open" } }),
          close,
        }}
        stats={{
          period: stats,
          // 最初は週を開く。期間を切り替えても戻るで1つずつ戻らないよう、履歴を置き換える
          show: () => void navigate({ search: { stats: "Week" } }),
          changePeriod: (period) => void navigate({ search: { stats: period }, replace: true }),
          close,
        }}
      />
    );
  },
});

export const router = createRouter({ routeTree: rootRoute.addChildren([homeRoute, loginRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
