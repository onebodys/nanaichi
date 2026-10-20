import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Result } from "@praha/byethrow";
import { DeletedJournalEntryJsonSchema, JournalEntryJsonSchema } from "../domain/journal-entry.ts";
import { schemaResult } from "../domain/schema-result.ts";
import { DeletedTagJsonSchema, TagListJsonSchema, TagUsageListJsonSchema } from "../domain/tag.ts";
import { TimelinePageJsonSchema } from "../domain/timeline.ts";
import { prepareDatabase, request, resetStorage, signInAs } from "./workers-test-harness.ts";

// 時計の扱いは session-api.workers.test.ts と同じ。alarm がすぐ鳴らないよう、本当の時計より先の時刻でテストする
const STARTED_AT = Date.UTC(2100, 0, 1, 0, 0, 0);
/** 最初のセッションを始めた時刻からの経過 */
const minutes = (m: number, s = 0) => STARTED_AT + m * 60_000 + s * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const ROUND_MINUTES = 3 * 8 + 5;

const passTo = (ms: number) => vi.setSystemTime(ms);

let headers: Headers;
let userId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  passTo(minutes(0));
  await prepareDatabase();
  ({ headers, userId } = await signInAs("me@example.com"));
});

afterEach(async () => {
  vi.useRealTimers();
  await resetStorage();
});

const withBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { cookie: headers.get("cookie") ?? "", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const start = () => request("/api/session", withBody("POST", { id: crypto.randomUUID() }));
const operate = (kind: string) =>
  request("/api/session/commands", withBody("POST", { id: crypto.randomUUID(), kind }));
/** `tags` を省くと、タグの項目を送らない（タグに対応する前の画面と同じ） */
const write = (body: unknown, id: string = crypto.randomUUID(), tags?: unknown) =>
  request("/api/journal-entries", withBody("POST", { id, body, tags }));
const edit = (id: string, body: unknown, tags: unknown = []) =>
  request(`/api/journal-entries/${id}`, withBody("PATCH", { body, tags }));
const tags = () => request("/api/tags", { headers });
const tagsJson = async () => (await tags()).json<{ tags: Array<string> }>();
const remove = (id: string) => request(`/api/journal-entries/${id}`, { method: "DELETE", headers });
const tagUsage = () => request("/api/tags/usage", { headers });
const tagUsageJson = async () =>
  (await tagUsage()).json<{ tags: Array<{ name: string; entryCount: number }> }>();
/** 名前は画面と同じく URL にエンコードして送る */
const deleteTag = (name: string, deletion: unknown) =>
  request(`/api/tags/${encodeURIComponent(name)}`, withBody("DELETE", deletion));
const entriesJson = async () => (await timelineJson()).sessions.flatMap(({ entries }) => entries);
const timeline = (before?: string) =>
  request(
    before === undefined ? "/api/timeline" : `/api/timeline?before=${encodeURIComponent(before)}`,
    { headers },
  );

type TimelineJson = {
  sessions: Array<{
    session: { id: string };
    entries: Array<{ id: string; body: string; tags: Array<string> }>;
  }>;
  next: { kind: "More"; before: string } | { kind: "End" };
};
const timelineJson = async (before?: string) => (await timeline(before)).json<TimelineJson>();

const alarmOf = () =>
  runInDurableObject(env.USER_DO.getByName(userId), (_, state) => state.storage.getAlarm());

describe("ログインしていないとき", () => {
  test.each([
    ["POST", "/api/journal-entries"],
    ["PATCH", `/api/journal-entries/${crypto.randomUUID()}`],
    ["DELETE", `/api/journal-entries/${crypto.randomUUID()}`],
    ["GET", "/api/timeline"],
    ["GET", "/api/tags"],
    ["GET", "/api/tags/usage"],
    ["DELETE", `/api/tags/${encodeURIComponent("読書")}`],
  ])("%s %s は 401 を返す", async (method, path) => {
    const res = await request(path, { method });

    expect(res.status).toBe(401);
  });
});

describe("ジャーナル記入を書く", () => {
  test("集中中に書くと、セッション・ラウンド・セット・フェーズに紐付き、書いた時刻が記録される", async () => {
    await start();
    passTo(minutes(3));
    const id = crypto.randomUUID();

    const res = await write("  設計を書いた\n次はテスト  ", id);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      body: "設計を書いた\n次はテスト",
      writtenAt: iso(minutes(3)),
      updatedAt: iso(minutes(3)),
      writtenDuring: { kind: "Focus", round: 1, setNumber: 1 },
    });
  });

  test("ジャーナル中に書くと、そのセットのジャーナルに紐付く", async () => {
    await start();
    passTo(minutes(7, 30));

    const res = await write("1セット目の振り返り");

    expect(await res.json()).toMatchObject({
      writtenDuring: { kind: "Journal", round: 1, setNumber: 1 },
    });
  });

  test("休憩中に書くと、ラウンドとフェーズだけに紐付き、セットには紐付かない", async () => {
    await start();
    passTo(minutes(26));

    const res = await write("休憩中のメモ");

    expect(await res.json()).toMatchObject({ writtenDuring: { kind: "Break", round: 1 } });
  });

  test("待機中に書くと、フェーズには紐付かず、次にやり直すセットに紐付く", async () => {
    await start();
    passTo(minutes(10));
    await operate("Abort");

    const res = await write("中断した理由");

    expect(await res.json()).toMatchObject({
      writtenDuring: { kind: "Idle", round: 1, setNumber: 2 },
    });
  });

  test("書くと、最後の記入から2ラウンド分の位置に自動終了の alarm を張り直す", async () => {
    await start();
    passTo(minutes(20));

    await write("メモ");

    expect(await alarmOf()).toBe(minutes(20 + 2 * ROUND_MINUTES));
  });

  test("同じ ID の記入を2回送っても1件しか記録せず、2回目には1回目の記入を返す", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("1回目", id);
    passTo(minutes(1));

    const retried = await write("1回目", id);

    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ id, writtenAt: iso(minutes(0)) });
    expect((await timelineJson()).sessions[0]?.entries).toHaveLength(1);
  });

  test("本文が空白だけなら 400 を返し、どの項目が不正かだけを示す", async () => {
    await start();

    const res = await write(" \n ");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST", paths: ["body"] });
  });

  test("本文が長すぎると 400 を返し、応答に本文を含めない", async () => {
    await start();
    const body = "あ".repeat(10_001);

    const res = await write(body);

    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("あ");
  });
});

describe("セッションの外では書けない", () => {
  test("セッションがなければ 409 を返し、記録しない", async () => {
    const res = await write("セッションの外のメモ");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "NO_SESSION_IN_PROGRESS" });
    expect((await timelineJson()).sessions).toEqual([]);
  });

  test("終了したあとは 409 を返す", async () => {
    await start();
    passTo(minutes(5));
    await operate("End");

    const res = await write("終了後のメモ");

    expect(res.status).toBe(409);
  });

  test("自動終了の時刻を過ぎていれば、セッションの外として 409 を返し、自動終了も延びない", async () => {
    await start();
    passTo(minutes(2 * ROUND_MINUTES));

    const res = await write("止め忘れたあとのメモ");

    expect(res.status).toBe(409);
    expect(await alarmOf()).toBeNull();
  });
});

describe("ジャーナル記入の編集", () => {
  test("本文を書き直すと、書いた時刻と紐付きはそのままで、更新時刻が変わる", async () => {
    await start();
    passTo(minutes(7, 30));
    const id = crypto.randomUUID();
    await write("書き間違い", id);
    passTo(minutes(9));

    const res = await edit(id, "書き直した");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      body: "書き直した",
      writtenAt: iso(minutes(7, 30)),
      updatedAt: iso(minutes(9)),
      writtenDuring: { kind: "Journal", round: 1, setNumber: 1 },
    });
    expect((await timelineJson()).sessions[0]?.entries).toMatchObject([{ body: "書き直した" }]);
  });

  test("セッションを終了したあとでも編集できる", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("メモ", id);
    await operate("End");

    const res = await edit(id, "終了後に直した");

    expect(res.status).toBe(200);
  });

  test("編集は新しい記入ではないので、自動終了の alarm を延ばさない", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("メモ", id);
    passTo(minutes(30));

    await edit(id, "直した");

    expect(await alarmOf()).toBe(minutes(2 * ROUND_MINUTES));
  });

  test("空の本文には書き直せない", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("メモ", id);

    const res = await edit(id, "");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST", paths: ["body"] });
  });

  test("記録されていない記入を編集すると 404 を返す", async () => {
    const res = await edit(crypto.randomUUID(), "メモ");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "JOURNAL_ENTRY_NOT_FOUND" });
  });

  test("他のユーザーの記入は編集できない", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("自分のメモ", id);
    const other = await signInAs("someone@example.com");

    const res = await request(`/api/journal-entries/${id}`, {
      method: "PATCH",
      headers: { cookie: other.headers.get("cookie") ?? "", "content-type": "application/json" },
      body: JSON.stringify({ body: "書き換え", tags: [] }),
    });

    expect(res.status).toBe(404);
  });
});

describe("ジャーナル記入の削除", () => {
  test("削除するとタイムラインに出なくなる", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("消すメモ", id);
    passTo(minutes(1));

    const res = await remove(id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, deletedAt: iso(minutes(1)) });
    expect((await timelineJson()).sessions[0]?.entries).toEqual([]);
  });

  test("削除は論理削除で、行は残り、自動終了の判断では書いたものとして数える", async () => {
    await start();
    passTo(minutes(20));
    const id = crypto.randomUUID();
    await write("消すメモ", id);

    await remove(id);

    const rows = await runInDurableObject(env.USER_DO.getByName(userId), (_, state) =>
      state.storage.sql.exec("SELECT id, deleted_at FROM journal_entries").toArray(),
    );
    expect(rows).toEqual([{ id, deleted_at: minutes(20) }]);
    expect(await alarmOf()).toBe(minutes(20 + 2 * ROUND_MINUTES));
  });

  test("削除の再送には、1回目の削除を返す", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("消すメモ", id);
    await remove(id);
    passTo(minutes(1));

    const retried = await remove(id);

    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ id, deletedAt: iso(minutes(0)) });
  });

  test("削除した記入は編集できず、同じ ID で書き直すこともできない", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("消すメモ", id);
    await remove(id);

    expect((await edit(id, "直す")).status).toBe(404);
    expect((await write("消すメモ", id)).status).toBe(404);
  });

  test("記録されていない記入を削除すると 404 を返す", async () => {
    const res = await remove(crypto.randomUUID());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "JOURNAL_ENTRY_NOT_FOUND" });
  });
});

describe("タグ", () => {
  test("記入にタグを複数つけると、表記ゆれを寄せた名前がつけた順に記録される", async () => {
    await start();

    const res = await write("本を読んだ", undefined, ["#読書", "Book", "読書"]);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ body: "本を読んだ", tags: ["読書", "book"] });
    expect((await timelineJson()).sessions[0]?.entries).toMatchObject([{ tags: ["読書", "book"] }]);
  });

  test("タグの項目を省いて書くと、タグのない記入になる", async () => {
    await start();

    const res = await write("タグなし");

    expect(await res.json()).toMatchObject({ tags: [] });
  });

  test("空白を含むタグは 400 を返し、どの項目が不正かだけを示す", async () => {
    await start();

    const res = await write("メモ", undefined, ["読書 メモ"]);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST", paths: ["tags.0"] });
  });

  test("同じタグを続けて書いた記入につけられる", async () => {
    await start();
    await write("1セット目", undefined, ["読書"]);
    passTo(minutes(8));
    await write("2セット目", undefined, ["読書"]);
    passTo(minutes(16));
    await write("3セット目", undefined, ["読書"]);

    expect((await timelineJson()).sessions[0]?.entries).toMatchObject([
      { tags: ["読書"] },
      { tags: ["読書"] },
      { tags: ["読書"] },
    ]);
  });

  test("編集でタグをつけ直せ、セッションを終了したあとでもできる", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("メモ", id, ["読書"]);
    await operate("End");

    const res = await edit(id, "メモ", ["設計", "レビュー"]);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tags: ["設計", "レビュー"] });
    expect((await timelineJson()).sessions[0]?.entries).toMatchObject([
      { tags: ["設計", "レビュー"] },
    ]);
  });

  test("編集でタグの項目を省くと 400 を返し、タグは変わらない", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("メモ", id, ["読書"]);

    const res = await request(`/api/journal-entries/${id}`, withBody("PATCH", { body: "直す" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST", paths: ["tags"] });
    expect((await timelineJson()).sessions[0]?.entries).toMatchObject([{ tags: ["読書"] }]);
  });

  test("使っているタグを、最近書いた記入についている順に返す", async () => {
    await start();
    await write("1", undefined, ["設計"]);
    passTo(minutes(1));
    await write("2", undefined, ["読書", "本"]);
    passTo(minutes(2));
    await write("3", undefined, ["設計"]);

    expect(await tagsJson()).toEqual({ tags: ["設計", "本", "読書"] });
  });

  test("削除した記入や編集で外したタグは、どの記入にもついていなければ一覧に出ない", async () => {
    await start();
    const removed = crypto.randomUUID();
    const edited = crypto.randomUUID();
    await write("消す", removed, ["消すタグ"]);
    await write("直す", edited, ["外すタグ", "残すタグ"]);

    await remove(removed);
    await edit(edited, "直す", ["残すタグ"]);

    expect(await tagsJson()).toEqual({ tags: ["残すタグ"] });
  });

  describe("使えるタグは20種類まで", () => {
    const useTwentyTags = async () => {
      await start();
      const names = Array.from({ length: 20 }, (_, i) => `tag${i + 1}`);
      const id = crypto.randomUUID();
      await write("20種類", id, names);
      return { id, names };
    };

    test("21種類目のタグをつけて書くと 409 を返し、記録しない", async () => {
      await useTwentyTags();

      const res = await write("21種類目", undefined, ["読書"]);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "TAG_LIMIT_EXCEEDED", limit: 20 });
      expect((await timelineJson()).sessions[0]?.entries).toHaveLength(1);
    });

    test("使っている20種類のタグなら、続けて書く記入にもつけられる", async () => {
      await useTwentyTags();

      const res = await write("同じタグ", undefined, ["tag1", "tag20"]);

      expect(res.status).toBe(200);
    });

    test("21種類目のタグをつけて編集すると 409 を返し、記入は変わらない", async () => {
      await useTwentyTags();
      const id = crypto.randomUUID();
      await write("あとで直す", id, ["tag1"]);

      const res = await edit(id, "直した", ["tag1", "読書"]);

      expect(res.status).toBe(409);
      expect((await timelineJson()).sessions[0]?.entries).toContainEqual(
        expect.objectContaining({ id, body: "あとで直す", tags: ["tag1"] }),
      );
    });

    test("その記入にしかついていないタグを外して付け替えるなら、編集できる", async () => {
      const { id, names } = await useTwentyTags();

      const res = await edit(id, "付け替えた", [...names.slice(0, 19), "読書"]);

      expect(res.status).toBe(200);
    });

    test("記入を削除してタグが使われなくなれば、その枠で新しいタグをつけられる", async () => {
      const { id } = await useTwentyTags();
      await remove(id);

      const res = await write("新しいタグ", undefined, ["読書"]);

      expect(res.status).toBe(200);
    });
  });

  test("他のユーザーのタグは見えず、上限にも数えない", async () => {
    await start();
    await write("自分のメモ", undefined, ["読書"]);
    const other = await signInAs("someone@example.com");

    const res = await request("/api/tags", { headers: other.headers });

    expect(await res.json()).toEqual({ tags: [] });
  });
});

describe("タイムライン", () => {
  /** `n` 個のセッションを10分おきに開始して終了する（i 番目は 10*i 分に開始） */
  const createSessions = async (n: number) => {
    const ids: Array<string> = [];
    for (let i = 0; i < n; i += 1) {
      passTo(minutes(10 * i));
      const started = await (await start()).json<{ session: { id: string } }>();
      ids.push(started.session.id);
      await write(`${i} 番目のセッションのメモ`);
      passTo(minutes(10 * i + 9));
      await operate("End");
    }
    return ids;
  };

  test("セッションがなければ空で、古いページもない", async () => {
    expect(await timelineJson()).toEqual({
      serverTime: iso(minutes(0)),
      sessions: [],
      next: { kind: "End" },
    });
  });

  test("進行中のセッションも、操作イベントと記入とともに含まれる", async () => {
    await start();
    passTo(minutes(7, 30));
    await write("振り返り");

    expect(await timelineJson()).toMatchObject({
      serverTime: iso(minutes(7, 30)),
      sessions: [
        {
          session: { events: [{ kind: "Start" }], journalEntryTimes: [iso(minutes(7, 30))] },
          entries: [{ body: "振り返り" }],
        },
      ],
      next: { kind: "End" },
    });
  });

  test("記入のないセッションも含まれる", async () => {
    await start();
    passTo(minutes(9));
    await operate("End");

    expect((await timelineJson()).sessions).toMatchObject([{ entries: [] }]);
  });

  test("セッションを新しい順に10件ずつ返し、before で古いページを送れる", async () => {
    const ids = await createSessions(11);

    const first = await timelineJson();
    expect(first.sessions.map(({ session }) => session.id)).toEqual(ids.slice(1).reverse());
    expect(first.next).toEqual({ kind: "More", before: iso(minutes(10)) });

    const second = await timelineJson(iso(minutes(10)));
    expect(second.sessions.map(({ session }) => session.id)).toEqual([ids[0]]);
    expect(second.next).toEqual({ kind: "End" });
  });

  test("before が時刻でなければ 400 を返す", async () => {
    const res = await timeline("yesterday");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST", paths: ["before"] });
  });

  test("他のユーザーのセッションと記入は見えない", async () => {
    await start();
    await write("自分のメモ");
    const other = await signInAs("someone@example.com");

    const res = await request("/api/timeline", { headers: other.headers });

    expect(await res.json()).toMatchObject({ sessions: [] });
  });
});

describe("タグの削除", () => {
  test("設定画面の一覧には、使っているタグと、ついている削除していない記入の数を最近使った順に返す", async () => {
    await start();
    await write("1", undefined, ["設計"]);
    await write("2", undefined, ["設計"]);
    passTo(minutes(1));
    await write("3", undefined, ["読書"]);
    const removed = crypto.randomUUID();
    await write("消す", removed, ["読書"]);
    await remove(removed);

    expect(await tagUsageJson()).toEqual({
      tags: [
        { name: "読書", entryCount: 1 },
        { name: "設計", entryCount: 2 },
      ],
    });
  });

  test("外すだけで削除すると、記入は残ってタグだけが外れ、一覧からも消える", async () => {
    await start();
    await write("1", undefined, ["読書", "設計"]);
    await write("2", undefined, ["読書"]);

    const res = await deleteTag("読書", { kind: "Detach" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "読書", deletion: { kind: "Detach" } });
    expect((await entriesJson()).map(({ body, tags }) => ({ body, tags }))).toEqual([
      { body: "1", tags: ["設計"] },
      { body: "2", tags: [] },
    ]);
    expect(await tagsJson()).toEqual({ tags: ["設計"] });
  });

  test("別のタグに付け替えて削除すると、付け替え先がすでについている記入では1つにまとまる", async () => {
    await start();
    await write("1", undefined, ["読書", "設計"]);
    await write("2", undefined, ["本", "読書"]);

    const res = await deleteTag("読書", { kind: "Reassign", to: "本" });

    expect(res.status).toBe(200);
    expect((await entriesJson()).map(({ tags }) => tags)).toEqual([["本", "設計"], ["本"]]);
    expect(await tagUsageJson()).toEqual({
      tags: [
        { name: "本", entryCount: 2 },
        { name: "設計", entryCount: 1 },
      ],
    });
  });

  test("記入を編集するのではないので、更新時刻は変わらず、セッションが終わったあとでもできる", async () => {
    await start();
    await write("メモ", undefined, ["読書"]);
    await operate("End");
    passTo(minutes(60));

    const res = await deleteTag("読書", { kind: "Detach" });

    expect(res.status).toBe(200);
    expect(await entriesJson()).toMatchObject([
      { tags: [], writtenAt: iso(minutes(0)), updatedAt: iso(minutes(0)) },
    ]);
  });

  test("削除の記入とタグの名前は、表記ゆれを寄せて同じタグとして扱う", async () => {
    await start();
    await write("メモ", undefined, ["reading"]);

    const res = await deleteTag("＃Ｒｅａｄｉｎｇ", { kind: "Detach" });

    expect(res.status).toBe(200);
    expect(await tagsJson()).toEqual({ tags: [] });
  });

  test("上限の20種類を使っていても、タグを削除すれば空いた枠で新しいタグをつけられる", async () => {
    await start();
    await write(
      "20種類",
      undefined,
      Array.from({ length: 20 }, (_, i) => `tag${i + 1}`),
    );

    await deleteTag("tag1", { kind: "Reassign", to: "tag2" });
    const res = await write("新しいタグ", undefined, ["読書"]);

    expect(res.status).toBe(200);
  });

  test("どの記入にもついていないタグや、削除した記入にだけついていたタグは 404 を返す", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("消す", id, ["読書"]);
    await remove(id);

    const res = await deleteTag("読書", { kind: "Detach" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "TAG_NOT_FOUND" });
  });

  test("使っていないタグには付け替えられず 404 を返し、記入は変わらない", async () => {
    await start();
    await write("メモ", undefined, ["読書"]);

    const res = await deleteTag("読書", { kind: "Reassign", to: "本" });

    expect(res.status).toBe(404);
    expect((await entriesJson()).map(({ tags }) => tags)).toEqual([["読書"]]);
  });

  test("削除するタグ自身には付け替えられず 400 を返す", async () => {
    await start();
    await write("メモ", undefined, ["読書"]);

    const res = await deleteTag("読書", { kind: "Reassign", to: "#読書" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST", paths: ["to"] });
  });

  test("外すか付け替えるかを送らなければ 400 を返し、記入は変わらない", async () => {
    await start();
    await write("メモ", undefined, ["読書"]);

    const res = await deleteTag("読書", {});

    expect(res.status).toBe(400);
    expect((await entriesJson()).map(({ tags }) => tags)).toEqual([["読書"]]);
  });

  test("他のユーザーのタグは削除できず、自分の記入のタグも変わらない", async () => {
    await start();
    await write("自分のメモ", undefined, ["読書"]);
    const other = await signInAs("someone@example.com");

    const res = await request(`/api/tags/${encodeURIComponent("読書")}`, {
      method: "DELETE",
      headers: { cookie: other.headers.get("cookie") ?? "", "content-type": "application/json" },
      body: JSON.stringify({ kind: "Detach" }),
    });

    expect(res.status).toBe(404);
    expect(await tagsJson()).toEqual({ tags: ["読書"] });
  });
});

describe("応答はクライアントが検証するスキーマ（domain/）に合う", () => {
  test("設定画面のタグの一覧の応答は、そのスキーマに合う", async () => {
    await start();
    await write("メモ", undefined, ["読書"]);

    const parsed = schemaResult(TagUsageListJsonSchema)(await (await tagUsage()).json());

    expect(parsed).toEqual(Result.succeed({ tags: [{ name: "読書", entryCount: 1 }] }));
  });

  test("タグの削除の応答は、削除したタグのスキーマに合う", async () => {
    await start();
    await write("メモ", undefined, ["読書", "本"]);

    const parsed = schemaResult(DeletedTagJsonSchema)(
      await (await deleteTag("読書", { kind: "Reassign", to: "本" })).json(),
    );

    expect(parsed).toEqual(
      Result.succeed({ name: "読書", deletion: { kind: "Reassign", to: "本" } }),
    );
  });

  test("書いた記入の応答は、記入のスキーマで本文を Sensitive に包んで戻せる", async () => {
    await start();

    const parsed = schemaResult(JournalEntryJsonSchema)(await (await write("メモ")).json());

    expect(Result.isSuccess(parsed) && parsed.value.body.unwrap()).toBe("メモ");
  });

  test("タグの一覧の応答は、タグの一覧のスキーマに合う", async () => {
    await start();
    await write("メモ", undefined, ["＃Ｒｅａｄｉｎｇ"]);

    const parsed = schemaResult(TagListJsonSchema)(await (await tags()).json());

    expect(parsed).toEqual(Result.succeed({ tags: ["reading"] }));
  });

  test("削除の応答は、削除済みの記入のスキーマに合う", async () => {
    await start();
    const id = crypto.randomUUID();
    await write("メモ", id);

    const parsed = schemaResult(DeletedJournalEntryJsonSchema)(await (await remove(id)).json());

    expect(parsed).toEqual(Result.succeed({ id, deletedAt: new Date(minutes(0)) }));
  });

  test("休憩・待機・終了を含むタイムラインの応答は、タイムラインのスキーマに合う", async () => {
    await start();
    passTo(minutes(26));
    await write("休憩中");
    await operate("SkipBreak");
    passTo(minutes(28));
    await operate("Abort");
    await write("待機中");
    await operate("End");
    await start();
    await write("次のセッション");

    const parsed = schemaResult(TimelinePageJsonSchema)(await (await timeline()).json());

    expect(Result.isSuccess(parsed) && parsed.value.sessions).toHaveLength(2);
  });
});
