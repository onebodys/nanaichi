import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import * as v from "valibot";
import {
  exhaustRateLimit,
  prepareDatabase,
  request,
  resetStorage,
  signInAs,
} from "./workers-test-harness.ts";

// 時計の扱いは stats-api.workers.test.ts と同じ。alarm がすぐ鳴らないよう、本当の時計より先の時刻でテストする。
// 2100-01-01 0:00（UTC）は日本時間の 9:00
const T0 = Date.UTC(2100, 0, 1, 0, 0, 0);
const minutes = (m: number) => T0 + m * 60_000;
const passTo = (ms: number) => vi.setSystemTime(ms);

const ORIGIN = "http://localhost:5173";
const MCP_RESOURCE = `${ORIGIN}/api/mcp`;
const REDIRECT_URI = "http://localhost:33418/callback";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  passTo(minutes(0));
  await prepareDatabase();
});

afterEach(async () => {
  vi.useRealTimers();
  await resetStorage();
});

// ---------------------------------------------------------------------------
// 画面での記録（ログイン済みのセッションの cookie で、HTTP の API を呼ぶ）
// ---------------------------------------------------------------------------

const recorder = (cookie: string) => {
  const post = (path: string, body: unknown) =>
    request(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    start: () => post("/api/session", { id: crypto.randomUUID() }),
    end: () => post("/api/session/commands", { id: crypto.randomUUID(), kind: "End" }),
    write: async (body: string, tags: ReadonlyArray<string> = []) => {
      const id = crypto.randomUUID();
      expect((await post("/api/journal-entries", { id, body, tags })).status).toBe(200);
      return id;
    },
    remove: (id: string) =>
      request(`/api/journal-entries/${id}`, { method: "DELETE", headers: { cookie } }),
  };
};

// ---------------------------------------------------------------------------
// MCP クライアント（Claude Code などと同じ手順で、動的登録 → 認可 → 連携の許可 → トークン）
// ---------------------------------------------------------------------------

const base64url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const RegisteredSchema = v.object({ client_id: v.string() });
const ConsentedSchema = v.object({ url: v.string() });
const TokenSchema = v.object({ access_token: v.string() });

/** MCP クライアントを動的登録する（RFC 7591）。application_type は送らない（Claude Code と同じ） */
const registerClient = async (): Promise<string> => {
  const res = await request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test MCP Client",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  return v.parse(RegisteredSchema, await res.json()).client_id;
};

/** 認可の入口を開く。ログイン済みなら連携の許可の画面へ送られる。送られた先の URL を返す */
const authorize = async (cookie: string, clientId: string, verifier: string): Promise<URL> => {
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "journal:read offline_access",
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_RESOURCE,
  });
  const res = await request(`/api/auth/oauth2/authorize?${query.toString()}`, {
    headers: { cookie },
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "", ORIGIN);
};

/** 連携の許可の画面で、許可するか拒否する。MCP クライアントへ戻す URL を返す */
const consent = async (cookie: string, consentPage: URL, accept: boolean): Promise<URL> => {
  const res = await request("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ accept, oauth_query: consentPage.search.slice(1) }),
  });
  expect(res.status).toBe(200);
  return new URL(v.parse(ConsentedSchema, await res.json()).url);
};

/** 認可コードをアクセストークンに換える */
const exchange = async (clientId: string, code: string, verifier: string): Promise<string> => {
  const res = await request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP_RESOURCE,
    }),
  });
  expect(res.status).toBe(200);
  return v.parse(TokenSchema, await res.json()).access_token;
};

/** ログイン済みのユーザーが MCP クライアントをつなぎ、連携を許可して、アクセストークンを受け取る */
const connectClient = async (cookie: string): Promise<string> => {
  const clientId = await registerClient();
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const consentPage = await authorize(cookie, clientId, verifier);
  const back = await consent(cookie, consentPage, true);
  return exchange(clientId, back.searchParams.get("code") ?? "", verifier);
};

/** MCP サーバーに JSON-RPC を1つ送る（Streamable HTTP） */
const rpc = (accessToken: string, method: string, params?: unknown) =>
  request("/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

/** 応答は SSE の1件のメッセージ。`data:` の行の JSON-RPC の結果を返す */
const resultOf = async (res: Response): Promise<unknown> => {
  expect(res.status).toBe(200);
  const data = (await res.text()).split("\n").find((line) => line.startsWith("data: "));
  return v.parse(v.object({ result: v.unknown() }), JSON.parse(data?.slice(6) ?? "null")).result;
};

const ToolResultSchema = v.object({
  isError: v.optional(v.boolean()),
  content: v.tuple([v.object({ type: v.literal("text"), text: v.string() })]),
});

const callTool = async (accessToken: string, name: string, args: Record<string, unknown> = {}) =>
  v.parse(
    ToolResultSchema,
    await resultOf(await rpc(accessToken, "tools/call", { name, arguments: args })),
  );

/** ツールの結果（JSON の文字列）を読む。失敗なら例外にする */
const toolJson = async (accessToken: string, name: string, args?: Record<string, unknown>) => {
  const result = await callTool(accessToken, name, args);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text) as unknown;
};

const JournalPeriodSchema = v.object({
  period: v.object({ from: v.string(), to: v.string(), timeZone: v.string() }),
  entries: v.array(
    v.object({
      id: v.string(),
      body: v.string(),
      tags: v.array(v.string()),
      writtenOn: v.string(),
      writtenAtLocalTime: v.string(),
      writtenDuring: v.looseObject({ kind: v.string(), round: v.number() }),
    }),
  ),
});

const journalEntries = async (accessToken: string, from: string, to: string, timeZone: string) =>
  v.parse(
    JournalPeriodSchema,
    await toolJson(accessToken, "get_journal_entries", { from, to, timeZone }),
  );

// ---------------------------------------------------------------------------

describe("MCP クライアントが OAuth のサーバーを見つける", () => {
  test("Protected Resource Metadata は MCP サーバーの URL と、トークンを出すサーバーを返す", async () => {
    const res = await request("/.well-known/oauth-protected-resource/api/mcp");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: MCP_RESOURCE,
      authorization_servers: [`${ORIGIN}/api/auth`],
      scopes_supported: ["journal:read"],
    });
  });

  test("認可サーバーのメタデータは、動的登録と PKCE の入口を返す", async () => {
    const res = await request("/.well-known/oauth-authorization-server/api/auth");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      issuer: `${ORIGIN}/api/auth`,
      registration_endpoint: `${ORIGIN}/api/auth/oauth2/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  test("トークンなしで MCP サーバーを呼ぶと 401 で、Protected Resource Metadata の場所を返す", async () => {
    const res = await request("/api/mcp", { method: "POST", body: "{}" });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`,
    );
  });
});

describe("MCP サーバーを出すホスト", () => {
  test("portless の *.localhost では MCP サーバーを出さず、ログインはこれまでどおり使える", async () => {
    const portless = "http://issue36.nanaichi.localhost:5190";

    const mcp = await request("/api/mcp", { method: "POST", body: "{}" }, portless);
    const metadata = await request("/.well-known/oauth-protected-resource/api/mcp", {}, portless);
    const session = await request("/api/auth/get-session", {}, portless);

    expect(mcp.status).toBe(404);
    expect(metadata.status).toBe(404);
    expect(session.status).toBe(200);
  });
});

describe("連携の許可", () => {
  test("ログイン済みで MCP クライアントをつなぐと、連携の許可の画面へ送られる", async () => {
    const { headers } = await signInAs("me@example.com");
    const clientId = await registerClient();

    const consentPage = await authorize(headers.get("cookie") ?? "", clientId, "v".repeat(43));

    expect(consentPage.pathname).toBe("/oauth/consent");
    expect(consentPage.searchParams.get("client_id")).toBe(clientId);
    expect(consentPage.searchParams.get("scope")).toBe("journal:read offline_access");
  });

  test("ログインしていなければ、ログイン画面へ送られる", async () => {
    const clientId = await registerClient();

    const page = await authorize("", clientId, "v".repeat(43));

    expect(page.pathname).toBe("/login");
  });

  test("連携を拒否すると、MCP クライアントには認可コードが渡らない", async () => {
    const { headers } = await signInAs("me@example.com");
    const cookie = headers.get("cookie") ?? "";
    const clientId = await registerClient();
    const consentPage = await authorize(cookie, clientId, "v".repeat(43));

    const back = await consent(cookie, consentPage, false);

    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });
});

describe("MCP サーバーのツール", () => {
  test("ツールは記入・スタッツ・タグを読むものだけで、書き換えるものはない", async () => {
    const { headers } = await signInAs("me@example.com");
    const accessToken = await connectClient(headers.get("cookie") ?? "");

    const listed = v.parse(
      v.object({
        tools: v.array(
          v.object({ name: v.string(), annotations: v.object({ readOnlyHint: v.boolean() }) }),
        ),
      }),
      await resultOf(await rpc(accessToken, "tools/list")),
    );

    expect(listed.tools.map(({ name }) => name)).toEqual([
      "get_journal_entries",
      "get_stats",
      "get_tags",
    ]);
    expect(listed.tools.every(({ annotations }) => annotations.readOnlyHint)).toBe(true);
  });

  test("期間のジャーナル記入を、タイムゾーンで区切った日付で古い順に読める", async () => {
    const { headers } = await signInAs("me@example.com");
    const cookie = headers.get("cookie") ?? "";
    const me = recorder(cookie);
    // 1日目（日本時間 1/1 9:00〜）
    await me.start();
    passTo(minutes(3));
    await me.write("設計を読んだ", ["設計"]);
    await me.end();
    // 日本時間では 1/2 0:30、UTC ではまだ 1/1 15:30
    passTo(minutes(15 * 60 + 30));
    await me.start();
    passTo(minutes(15 * 60 + 31));
    await me.write("深夜に少しだけ");
    await me.end();
    // 日本時間 1/3 9:00
    passTo(minutes(48 * 60));
    await me.start();
    passTo(minutes(48 * 60 + 1));
    await me.write("3日目");
    await me.end();
    const accessToken = await connectClient(cookie);

    const tokyo = await journalEntries(accessToken, "2100-01-01", "2100-01-02", "Asia/Tokyo");
    const utc = await journalEntries(accessToken, "2100-01-01", "2100-01-01", "UTC");

    expect(tokyo.period).toEqual({ from: "2100-01-01", to: "2100-01-02", timeZone: "Asia/Tokyo" });
    expect(
      tokyo.entries.map(({ body, tags, writtenOn, writtenAtLocalTime }) => ({
        body,
        tags,
        writtenOn,
        writtenAtLocalTime,
      })),
    ).toEqual([
      {
        body: "設計を読んだ",
        tags: ["設計"],
        writtenOn: "2100-01-01",
        writtenAtLocalTime: "09:03",
      },
      { body: "深夜に少しだけ", tags: [], writtenOn: "2100-01-02", writtenAtLocalTime: "00:31" },
    ]);
    expect(tokyo.entries[0]?.writtenDuring).toEqual({ kind: "Focus", round: 1, setNumber: 1 });
    // UTC で区切ると、日本時間 1/2 0:31 の記入は 1/1 15:31 になる
    expect(utc.entries.map(({ body, writtenAtLocalTime }) => [body, writtenAtLocalTime])).toEqual([
      ["設計を読んだ", "00:03"],
      ["深夜に少しだけ", "15:31"],
    ]);
  });

  test("削除した記入は読めない", async () => {
    const { headers } = await signInAs("me@example.com");
    const cookie = headers.get("cookie") ?? "";
    const me = recorder(cookie);
    await me.start();
    passTo(minutes(1));
    const removed = await me.write("消す");
    await me.write("残す");
    await me.remove(removed);
    const accessToken = await connectClient(cookie);

    const { entries } = await journalEntries(accessToken, "2100-01-01", "2100-01-01", "Asia/Tokyo");

    expect(entries.map(({ body }) => body)).toEqual(["残す"]);
  });

  test.each([
    ["from が to より後", { from: "2100-01-02", to: "2100-01-01", timeZone: "Asia/Tokyo" }],
    ["期間が 366 日より長い", { from: "2100-01-01", to: "2101-01-02", timeZone: "Asia/Tokyo" }],
    ["暦にない日付", { from: "2100-02-30", to: "2100-03-01", timeZone: "Asia/Tokyo" }],
    ["タイムゾーンではない", { from: "2100-01-01", to: "2100-01-01", timeZone: "Mars/Olympus" }],
  ])("期間の指定が不正（%s）なら、ツールのエラーとして返す", async (_, args) => {
    const { headers } = await signInAs("me@example.com");
    const accessToken = await connectClient(headers.get("cookie") ?? "");

    const result = await callTool(accessToken, "get_journal_entries", args);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("引数が不正です");
  });

  test("スタッツとタグを読める", async () => {
    const { headers } = await signInAs("me@example.com");
    const cookie = headers.get("cookie") ?? "";
    const me = recorder(cookie);
    await me.start();
    passTo(minutes(3));
    await me.write("読書した", ["読書"]);
    // 1セット目の集中（7分）を終える
    passTo(minutes(8));
    const accessToken = await connectClient(cookie);

    const stats = await toolJson(accessToken, "get_stats", {
      period: "Today",
      timeZone: "Asia/Tokyo",
    });
    const tags = await toolJson(accessToken, "get_tags");

    expect(stats).toEqual({
      period: "Today",
      today: "2100-01-01",
      range: { from: "2100-01-01", to: "2100-01-01" },
      activity: {
        kind: "Active",
        completedSets: 1,
        abortedSets: 0,
        comparison: { kind: "Compared", previousCompletedSets: 0 },
        entries: 1,
        completedSetsWithEntry: 1,
        trend: { kind: "None" },
        tags: [{ name: "読書", completedSets: 1 }],
        hours: [{ hour: 9, completedSets: 1 }],
      },
      streak: { current: 1, longest: 1 },
    });
    expect(tags).toEqual({ tags: ["読書"] });
  });

  test("スタッツの日ごとには、まだ来ていない日もこの12週間の日ごとも入らない", async () => {
    const { headers } = await signInAs("me@example.com");
    const cookie = headers.get("cookie") ?? "";
    const me = recorder(cookie);
    await me.start();
    passTo(minutes(8));
    const accessToken = await connectClient(cookie);

    // 2100-01-01 は金曜日。今週は 2099-12-28（月）から 2100-01-03（日）まで
    const stats = v.parse(
      v.object({
        range: v.object({ from: v.string(), to: v.string() }),
        activity: v.object({
          trend: v.object({
            kind: v.literal("Days"),
            days: v.array(v.object({ date: v.string(), completedSets: v.number() })),
          }),
        }),
      }),
      await toolJson(accessToken, "get_stats", { period: "Week", timeZone: "Asia/Tokyo" }),
    );

    expect(stats).not.toHaveProperty("calendar");
    expect(stats.range).toEqual({ from: "2099-12-28", to: "2100-01-03" });
    expect(stats.activity.trend.days.map(({ date }) => date)).toEqual([
      "2099-12-28",
      "2099-12-29",
      "2099-12-30",
      "2099-12-31",
      "2100-01-01",
    ]);
  });

  test("この12週間の日ごとは、求めたときだけ今日までの日を返す", async () => {
    const { headers } = await signInAs("me@example.com");
    const cookie = headers.get("cookie") ?? "";
    const me = recorder(cookie);
    await me.start();
    passTo(minutes(8));
    const accessToken = await connectClient(cookie);

    const { calendar } = v.parse(
      v.object({ calendar: v.array(v.object({ date: v.string(), completedSets: v.number() })) }),
      await toolJson(accessToken, "get_stats", {
        period: "Today",
        timeZone: "Asia/Tokyo",
        includeCalendar: true,
      }),
    );

    // 11週前の月曜から今日（金曜）まで
    expect(calendar).toHaveLength(11 * 7 + 5);
    expect(calendar.at(-1)).toEqual({ date: "2100-01-01", completedSets: 1 });
  });

  test("トークンを渡したユーザーの記録だけを読め、ほかのユーザーの記録は読めない", async () => {
    const someone = await signInAs("someone@example.com");
    const other = recorder(someone.headers.get("cookie") ?? "");
    await other.start();
    passTo(minutes(1));
    await other.write("ほかのユーザーの記入");
    const { headers } = await signInAs("me@example.com");
    const accessToken = await connectClient(headers.get("cookie") ?? "");

    const { entries } = await journalEntries(accessToken, "2100-01-01", "2100-01-01", "Asia/Tokyo");

    expect(entries).toEqual([]);
  });
});

describe("アクセストークンの確認", () => {
  test("期限（1時間）が切れたトークンでは 401 になる", async () => {
    const { headers } = await signInAs("me@example.com");
    const accessToken = await connectClient(headers.get("cookie") ?? "");

    passTo(minutes(61));
    const res = await rpc(accessToken, "tools/list");

    expect(res.status).toBe(401);
  });

  test("書き換えたトークンでは 401 になる", async () => {
    const { headers } = await signInAs("me@example.com");
    const accessToken = await connectClient(headers.get("cookie") ?? "");
    const [header, , signature] = accessToken.split(".");
    const forged = btoa(JSON.stringify({ sub: "someone-else", aud: MCP_RESOURCE }))
      .replaceAll("=", "")
      .replaceAll("+", "-")
      .replaceAll("/", "_");

    const res = await rpc(`${header}.${forged}.${signature}`, "tools/list");

    expect(res.status).toBe(401);
  });

  test("許可リストに載っていないユーザーのトークンでは 403 になる", async () => {
    // テスト用のログインは許可リストを照合しないので、外れたユーザーのセッションが作れる（test-auth.ts）
    const { headers } = await signInAs("stranger@example.com");
    const accessToken = await connectClient(headers.get("cookie") ?? "");

    const res = await rpc(accessToken, "tools/list");

    expect(res.status).toBe(403);
  });
});

// 制限を使い切るのに 100〜300 回送るので、既定の 5 秒では足りないことがある（rate-limit.workers.test.ts）
describe("レート制限（ADR 0018）", { timeout: 30_000 }, () => {
  test("画面からのリクエストで制限に達したユーザーは、MCP からも 429 になる", async () => {
    const { headers } = await signInAs("me@example.com");
    const accessToken = await connectClient(headers.get("cookie") ?? "");
    await exhaustRateLimit(headers);

    const res = await rpc(accessToken, "tools/list");

    expect(res.status).toBe(429);
  });
});
