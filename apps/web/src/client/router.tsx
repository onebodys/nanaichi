import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { Result } from "@praha/byethrow";
import * as v from "valibot";
import type { Backend } from "../domain/backend.ts";
import { STATS_PERIODS } from "../domain/stats.ts";
import { attachedTagsKeyOf } from "./attached-tags.ts";
import { authClient, redirectToLogin } from "./auth-client.ts";
import { BackendProvider } from "./backend.ts";
import { ConsentPage } from "./consent-page.tsx";
import { HomePage } from "./home-page.tsx";
import { ImportDialog } from "./import-dialog.tsx";
import { LoginPage } from "./login-page.tsx";
import {
  RecordStoreProvider,
  resolveRecordStore,
  type RecordStore,
  type RecordStoreUnknown,
} from "./record-store.ts";
import { RecordStoreUnknownPage } from "./record-store-unknown-page.tsx";
import { createRemoteBackend } from "./remote-backend.ts";
import { ImportProvider } from "./use-import.ts";

type HomeSetup = Result.Result<
  Readonly<{ recordStore: RecordStore; backend: Backend }>,
  RecordStoreUnknown
>;

const createBackendFor = async (recordStore: RecordStore): Promise<Backend> => {
  switch (recordStore.kind) {
    case "Device": {
      const { createBrowserDeviceBackend } = await import("../device/index.ts");
      return createBrowserDeviceBackend();
    }
    case "Account":
      return createRemoteBackend({ onSignedOut: redirectToLogin });
  }
};

const prepareHome = async (): Promise<HomeSetup> => {
  const resolved = await resolveRecordStore();
  if (Result.isFailure(resolved)) {
    return resolved;
  }
  const recordStore = resolved.value;
  return Result.succeed({ recordStore, backend: await createBackendFor(recordStore) });
};

/**
 * 記録先は読み込みごとに1度だけ決める。ルートの beforeLoad は設定画面を開くなどの URL の変更でも走るが、
 * そのたびに `Backend`（端末の記録なら同期の窓口）を作り直さない
 */
let homeSetup: Promise<HomeSetup> | undefined;
const setupHome = (): Promise<HomeSetup> => (homeSetup ??= prepareHome());

/** ログインした直後の印を URL から消す。読み込み直したときや戻ったときに、もう一度尋ねない */
const forgetFromLogin = () =>
  void router.navigate({
    to: "/",
    search: (search) => ({ ...search, from: undefined }),
    replace: true,
  });

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
 * 連携の許可の画面の URL の値（ADR 0017）。認可の入口が署名して付けるもののうち、画面に出すものだけを読む。
 * 署名を確かめて許可に使うのはサーバーで、画面は URL をそのまま `oauthProviderClient` に渡す（auth-client.ts）
 */
const ConsentSearchSchema = v.object({
  client_id: v.optional(v.string()),
  scope: v.optional(v.string()),
  redirect_uri: v.optional(v.string()),
});

const consentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/oauth/consent",
  validateSearch: (search) => {
    const parsed = v.safeParse(ConsentSearchSchema, search);
    return parsed.success ? parsed.output : {};
  },
  // 認可の入口はログインしていなければログイン画面へ送るので、ここへはログイン済みで来る。
  // セッションが切れていたときだけ、ログイン画面へ送る
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (data === null) {
      throw redirect({ to: "/login" });
    }
  },
  component: () => {
    const search = consentRoute.useSearch();
    return (
      <ConsentPage
        clientId={search.client_id}
        scope={search.scope}
        redirectUri={search.redirect_uri}
      />
    );
  },
});

/**
 * 設定画面・スタッツを重ねて開いているか（`?settings=open`、`?stats=<期間>`）と、ログインした直後か（`?from=login`）。ホーム画面の上に重ねるだけなので、
 * 別のルートにはしない（ルートを移るとホーム画面が外れ、タイマーと知らせが止まる）。外から来る値なのでスキーマで検証する
 */
const HomeSearchSchema = v.object({
  settings: v.optional(v.literal("open")),
  stats: v.optional(v.picklist(STATS_PERIODS)),
  /** ログインした直後（ログイン画面の `callbackURL`）。この端末の記録を取り込むかを尋ねる（ADR 0020） */
  from: v.optional(v.literal("login")),
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search) => {
    const parsed = v.safeParse(HomeSearchSchema, search);
    return parsed.success ? parsed.output : {};
  },
  beforeLoad: async () => ({ setup: await setupHome() }),
  component: () => {
    const { settings, stats, from } = homeRoute.useSearch();
    const { setup } = homeRoute.useRouteContext();
    const navigate = homeRoute.useNavigate();
    if (Result.isFailure(setup)) {
      return <RecordStoreUnknownPage />;
    }
    const { recordStore, backend } = setup.value;
    // 閉じた画面に戻るで戻らないよう、履歴を置き換える
    const close = () => void navigate({ search: {}, replace: true });
    const home = (
      <HomePage
        attachedTagsKey={attachedTagsKeyOf(recordStore)}
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
    return (
      <RecordStoreProvider recordStore={recordStore}>
        <BackendProvider backend={backend}>
          {recordStore.kind === "Account" ? (
            <ImportProvider>
              {home}
              <ImportDialog fromLogin={from === "login"} forgetFromLogin={forgetFromLogin} />
            </ImportProvider>
          ) : (
            home
          )}
        </BackendProvider>
      </RecordStoreProvider>
    );
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, loginRoute, consentRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
