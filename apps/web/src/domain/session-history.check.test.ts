import { Result } from "@praha/byethrow";
import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { AdvanceMode, AdvanceModeChange } from "./advance-mode.ts";
import { SessionEventId, SessionOperationKind } from "./session-event.ts";
import { Session, SessionId } from "./session.ts";
import type { TimerState } from "./timer-state.ts";

/**
 * セッションの記録に対する有界の網羅検査（.claude/skills/session-history/SKILL.md）。
 *
 * 開始から、操作・ジャーナル記入・フェーズの進め方の変更を `DEPTH` 回まで、
 * 時間の進み `STEPS_MS` のどれかを挟んで行う並びを、受け付けられるものはすべて作り、
 * 1つ足すたびに下の約束を確かめる。サンプルではなく、この範囲のすべての並びを試す。
 * `DEPTH` は vitest.node.config.ts が環境変数 SESSION_HISTORY_DEPTH から埋め込む。
 */
declare const __SESSION_HISTORY_DEPTH__: number;
const DEPTH = __SESSION_HISTORY_DEPTH__;

const MINUTE = 60_000;
/** 同じミリ秒・1ミリ秒後・ジャーナルの長さ・集中の長さ・自動終了までの長さ（2ラウンド分） */
const STEPS_MS = [0, 1, MINUTE, 7 * MINUTE, 58 * MINUTE] as const;
/** 記録したあとに状態を計算し直す時刻（記録した時刻からの差）。自動終了の時刻を越えるまで */
const PROBES_MS = [0, 1, MINUTE, 7 * MINUTE, 13 * MINUTE, 58 * MINUTE, 120 * MINUTE] as const;

const MODES = [
  AdvanceMode.default,
  {
    FocusToJournal: "Manual",
    JournalToFocus: "Manual",
    JournalToBreak: "Manual",
    BreakToFocus: "Manual",
  },
  { ...AdvanceMode.default, FocusToJournal: "Manual" },
] as const satisfies ReadonlyArray<AdvanceMode>;

const STARTED_AT = Date.UTC(2026, 9, 17, 0, 0, 0);
const sessionId = v.parse(SessionId.schema, "00000000-0000-4000-8000-000000000000");
const eventId = v.parse(SessionEventId.schema, "00000000-0000-4000-8000-000000000001");

type Command =
  | Readonly<{ kind: "Operation"; operation: (typeof SessionOperationKind.schema.options)[number] }>
  | Readonly<{ kind: "JournalEntry" }>
  | Readonly<{ kind: "AdvanceModeChange"; mode: AdvanceMode }>;

const COMMANDS: ReadonlyArray<Command> = [
  ...SessionOperationKind.schema.options.map((operation): Command => ({
    kind: "Operation",
    operation,
  })),
  { kind: "JournalEntry" },
  ...MODES.map((mode): Command => ({ kind: "AdvanceModeChange", mode })),
];

const nameOfMode = (mode: AdvanceMode): string =>
  AdvanceMode.transitions.filter((t) => mode[t] === "Manual").join("+") || "すべて自動";

const describeCommand = (command: Command): string => {
  switch (command.kind) {
    case "Operation":
      return command.operation;
    case "JournalEntry":
      return "ジャーナル記入";
    case "AdvanceModeChange":
      return `進め方を「${nameOfMode(command.mode)}」に`;
  }
};

/** 開始からの手順。反例を読める形で出すために持つ */
type Node = Readonly<{ session: Session; lastAt: number; trace: ReadonlyArray<string> }>;

/**
 * ワークフローと同じ受け付け方で、時刻 `now` にコマンドを1つ記録したあとのセッション。受け付けられなければ undefined。
 *
 * - 操作: `operateSession` と同じく `Session.operate` で判断する
 * - 記入: `writeJournalEntry` は終了していないセッションにだけ書ける
 * - 進め方の変更: `changeAdvanceMode` は同じ進め方なら記録しない。進行中のセッションの計算に加わる
 */
const record = (session: Session, command: Command, now: Date): Session | undefined => {
  switch (command.kind) {
    case "Operation": {
      const operated = Session.operate(session, { kind: command.operation, id: eventId, at: now });
      return Result.isSuccess(operated) ? operated.value.session : undefined;
    }
    case "JournalEntry":
      return { ...session, journalEntryTimes: [...session.journalEntryTimes, now] };
    case "AdvanceModeChange":
      return AdvanceMode.equals(
        AdvanceModeChange.modeAt(session.advanceModeChanges, now),
        command.mode,
      )
        ? undefined
        : Session.withAdvanceModeChange(session, { at: now, mode: command.mode });
  }
};

type Violation = Readonly<{ property: string; trace: ReadonlyArray<string>; detail: string }>;

const isAutoEnded = (state: TimerState): boolean =>
  state.kind === "Ended" && state.endedBy === "AutoEnd";

/** 記録したセッションが守るべき約束。破れていれば理由を返す */
const PROPERTIES: ReadonlyArray<
  Readonly<{ name: string; check: (session: Session, recordedAt: number) => string | undefined }>
> = [
  {
    name: "受け付けた記録は、そのあといつ計算し直しても状態になる",
    check: (session, recordedAt) => {
      for (const probe of PROBES_MS) {
        const now = new Date(recordedAt + probe);
        try {
          Session.stateAt(session, now);
          Session.setOutcomesAt(session, now);
        } catch (error) {
          return `記録の ${probe}ms 後: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      return undefined;
    },
  },
  {
    name: "完了セットの数は、状態とセットの結末で一致する",
    check: (session, recordedAt) => {
      for (const probe of PROBES_MS) {
        const now = new Date(recordedAt + probe);
        const fromState = Session.stateAt(session, now).completedSets;
        const fromOutcomes = Session.setOutcomesAt(session, now).filter(
          (set) => set.kind === "CompletedSet",
        ).length;
        if (fromState !== fromOutcomes) {
          return `記録の ${probe}ms 後: 状態 ${fromState}, 結末 ${fromOutcomes}`;
        }
      }
      return undefined;
    },
  },
  {
    // alarm は autoEndDueAt に鳴る。その時刻に終了していなければ同じ時刻に張り直し、鳴り続ける
    name: "自動終了の時刻より前には自動終了せず、その時刻には終了している",
    check: (session) => {
      const due = Session.autoEndDueAt(session).getTime();
      const before = Session.stateAt(session, new Date(due - 1));
      const atDue = Session.stateAt(session, new Date(due));
      if (isAutoEnded(before)) return "自動終了の時刻の 1ms 前にもう自動終了している";
      if (atDue.kind !== "Ended") return `自動終了の時刻に ${atDue.kind} のまま`;
      return undefined;
    },
  },
  {
    name: "動いているフェーズの残り時間は 1 秒以上で、終わる時刻はいまより後",
    check: (session, recordedAt) => {
      for (const probe of PROBES_MS) {
        const now = recordedAt + probe;
        const state = Session.stateAt(session, new Date(now));
        switch (state.kind) {
          case "Focus":
          case "Journal":
          case "Break":
            if (state.remainingSeconds < 1)
              return `記録の ${probe}ms 後: ${state.kind} の残りが 0 秒`;
            if (state.clock.kind === "Running" && state.clock.endsAt.getTime() <= now) {
              return `記録の ${probe}ms 後: ${state.kind} が終わる時刻を過ぎても動いている`;
            }
            break;
          case "Idle":
          case "AwaitingAdvance":
          case "Ended":
            break;
        }
      }
      return undefined;
    },
  },
];

/** 約束の確かめ方の途中で計算できなくなっても、その約束が破れたとして反例に残す */
const checkSafely = (
  check: (session: Session, recordedAt: number) => string | undefined,
  node: Node,
): string | undefined => {
  try {
    return check(node.session, node.lastAt);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const exploreTo = (
  maxDepth: number,
): Readonly<{ violations: ReadonlyArray<Violation>; checked: number }> => {
  const violations = new Map<string, Violation>();
  let checked = 0;

  const visit = (node: Node, depth: number): void => {
    checked += 1;
    for (const property of PROPERTIES) {
      if (violations.has(property.name)) continue;
      const detail = checkSafely(property.check, node);
      if (detail !== undefined) {
        violations.set(property.name, { property: property.name, trace: node.trace, detail });
      }
    }
    if (depth === maxDepth || violations.size > 0) return;
    for (const step of STEPS_MS) {
      const now = new Date(node.lastAt + step);
      // 終了したセッションは閉じられ、そのあとは何も記録されない（loadOpenSession）
      if (Session.stateAt(node.session, now).kind === "Ended") continue;
      for (const command of COMMANDS) {
        const session = record(node.session, command, now);
        if (session === undefined) continue;
        visit(
          {
            session,
            lastAt: now.getTime(),
            trace: [...node.trace, `+${step}ms ${describeCommand(command)}`],
          },
          depth + 1,
        );
      }
    }
  };

  for (const mode of MODES) {
    const changes = [{ at: new Date(STARTED_AT - 1), mode }];
    visit(
      {
        session: Session.start(sessionId, eventId, new Date(STARTED_AT), changes),
        lastAt: STARTED_AT,
        trace: [`進め方「${nameOfMode(mode)}」で開始`],
      },
      0,
    );
  }
  return { violations: [...violations.values()], checked };
};

/** 浅い手数から順に探し、約束が破れた最初の手数で止める。反例はその約束を破るいちばん短い並びになる */
const explore = (): Readonly<{ violations: ReadonlyArray<Violation>; checked: number }> => {
  let result = exploreTo(0);
  for (let depth = 1; depth <= DEPTH && result.violations.length === 0; depth += 1) {
    result = exploreTo(depth);
  }
  return result;
};

describe("セッションの記録の網羅検査", () => {
  test("開始から決まった手数までの、受け付けられるすべての記録の並びで約束が守られる", () => {
    const { violations, checked } = explore();
    expect(violations).toEqual([]);
    expect(checked).toBeGreaterThan(1000);
  }, 0);
});
