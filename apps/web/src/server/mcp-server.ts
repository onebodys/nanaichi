import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { Result } from "@praha/byethrow";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { JOURNAL_PERIOD_MAX_DAYS } from "../domain/journal-period.ts";
import type { ValidationError } from "../domain/schema-result.ts";
import { CompactStats, STATS_PERIODS } from "../domain/stats.ts";
import type { UserDO } from "./user-do.ts";
import { describeIssuePaths } from "./validation-error.ts";

// ---------------------------------------------------------------------------
// ツールの引数。MCP クライアントに見せる形（JSON Schema）と説明だけを持つ。
// 日付が暦にあるか・タイムゾーンが正しいかなどの検証は、HTTP の API と同じくワークフローが行う
// ---------------------------------------------------------------------------

const TimeZoneArg = v.pipe(
  v.string(),
  v.description(
    "日付を区切るタイムゾーン（IANA の名前、例: Asia/Tokyo）。ユーザーの住んでいる地域のものを渡す",
  ),
);

const JournalEntriesArgs = toStandardJsonSchema(
  v.object({
    from: v.pipe(v.string(), v.description("期間の最初の日付（YYYY-MM-DD）。この日を含む")),
    to: v.pipe(v.string(), v.description("期間の最後の日付（YYYY-MM-DD）。この日を含む")),
    timeZone: TimeZoneArg,
  }),
);

const StatsArgs = toStandardJsonSchema(
  v.object({
    period: v.pipe(
      v.picklist(STATS_PERIODS),
      v.description("期間。Today は今日、Week は今週（月曜から）、Month は今月、All はすべて"),
    ),
    timeZone: TimeZoneArg,
    includeCalendar: v.pipe(
      v.optional(v.boolean(), false),
      v.description(
        "true なら、この12週間の日ごとの完了セット数（今日まで）も返す。週ごとの習慣を見るときだけ求める",
      ),
    ),
  }),
);

/** ツールの結果は JSON の文字列で返す。AI がそのまま読める */
const jsonResult = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

/**
 * 想定内の失敗（引数の誤り）を、AI が読んで直せるツールのエラーにする。
 * 引数の値はエラーに含めず、どの引数が不正かだけを返す（HTTP の API と同じ）
 */
const validationErrorResult = (error: ValidationError): CallToolResult => ({
  isError: true,
  content: [
    { type: "text", text: `引数が不正です: ${describeIssuePaths(error).join(", ") || "(全体)"}` },
  ],
});

const toToolResult = <T>(result: Result.Result<T, ValidationError>): CallToolResult =>
  Result.isSuccess(result) ? jsonResult(result.value) : validationErrorResult(result.error);

/**
 * 1人のユーザーの記録を読む MCP サーバー（GLOSSARY「MCP サーバー」）。リクエストごとに作る。
 *
 * ツールはすべて読むだけ。書き換える操作は作らない（ADR 0017）。
 * 判断と読み出しは HTTP の API と同じく UserDO のワークフローが行い、ここは MCP の形に変えるだけ。
 */
export const createMcpServer = (userDO: DurableObjectStub<UserDO>): McpServer => {
  const server = new McpServer({ name: "nanaichi", version: "1.0.0" });

  server.registerTool(
    "get_journal_entries",
    {
      title: "期間のジャーナル記入",
      description: [
        "nanaichi（7分の集中と1分のジャーナルを繰り返すタイマー）で、期間内に書いたジャーナル記入を古い順に返す。",
        "1週間の活動のまとめなど、振り返りに使う。",
        "記入ごとに本文・タグ・書いた日付と時刻・セッション ID・書いた時点のフェーズ（writtenDuring: Focus は集中、Journal はジャーナル、Break は休憩、Idle は待機。round はラウンド、setNumber はセット番号）を持つ。",
        `期間は ${JOURNAL_PERIOD_MAX_DAYS} 日まで。`,
      ].join(""),
      inputSchema: JournalEntriesArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => toToolResult(await userDO.getJournalPeriod(args)),
  );

  server.registerTool(
    "get_stats",
    {
      title: "スタッツ",
      description: [
        "nanaichi の期間ごとのスタッツを返す。日付は YYYY-MM-DD。",
        "期間（range）・完了セット数（1セットは7分の集中）・不成立セット数・ジャーナル記入の数・記入のある完了セットの数・前の期間の同じ時点までの完了セット数（comparison）・",
        "日ごと（今日まで。すべての期間は月ごと）の完了セット数（trend）・タグごとの完了セット数（多い順に5つ）・完了セットのある時間帯（hours）・連続日数（streak）を含む。",
        "期間に記録がなければ activity は NoActivity。includeCalendar を true にすると、この12週間の日ごとの完了セット数（calendar）も返す。",
      ].join(""),
      inputSchema: StatsArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ includeCalendar, ...query }) =>
      toToolResult(
        Result.pipe(
          await userDO.getStats(query),
          Result.map((report) =>
            includeCalendar ? CompactStats.withCalendarOf(report) : CompactStats.of(report),
          ),
        ),
      ),
  );

  server.registerTool(
    "get_tags",
    {
      title: "タグ",
      description:
        "nanaichi のジャーナル記入についているタグ（#読書 のような短い名前）を、最近使った順に返す。",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => toToolResult(await userDO.getTags()),
  );

  return server;
};
