import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import * as v from "valibot";
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

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // 画面の出し分けだけを行う。実際の保護はサーバー側の /api/* ミドルウェア。
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (data === null) {
      throw redirect({ to: "/login" });
    }
  },
  component: HomePage,
});

export const router = createRouter({ routeTree: rootRoute.addChildren([homeRoute, loginRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
