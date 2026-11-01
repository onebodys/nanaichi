import { Result } from "@praha/byethrow";
import * as v from "valibot";
import type { AdvanceMode } from "../../domain/advance-mode.ts";
import { JournalEntryBody, JournalEntryId } from "../../domain/journal-entry.ts";
import { localDateIn } from "../../domain/local-date.ts";
import { phaseChangeBetween } from "../../domain/phase-change.ts";
import {
  remainingRatioOf,
  roundProgressOf,
  upcomingPhaseOf,
  type Segment,
} from "../../domain/round-progress.ts";
import { rhythmBeatsOf } from "./rhythm-score.ts";
import { SessionEventId, type SessionOperation } from "../../domain/session-event.ts";
import { SessionSummary } from "../../domain/session-summary.ts";
import { Session, SessionId } from "../../domain/session.ts";
import { nextPhase, type Phase, type TimerState } from "../../domain/timer-state.ts";
import type { AlertTone } from "../alert-settings.ts";
import { completedSetsAndFocusTimeOf, focusTimeLabelOf } from "../focus-time-text.ts";
import {
  dateLabelOf,
  daySessionLabelOf,
  timeLabelOf,
  writtenDuringBadgeOf,
} from "../journal-text.ts";
import { operationButtonsOf } from "../operation-layout.ts";
import type { PhaseAlert } from "../phase-alert.ts";
import { shouldSubmit } from "../submit-key.ts";
import {
  advanceLabelOf,
  awaitingLabelOf,
  countdownPartsOf,
  currentSessionLabelOf,
  idleMessageOf,
  operationLabelOf,
  pausedForLabelOf,
  phaseLabelOf,
  positionOf,
  sessionRhythmOf,
  sessionSpanLabelOf,
  upcomingLabelOf,
} from "../timer-text.ts";
import { Demo } from "./demo-session.ts";

/**
 * LP のいちばん上で動くタイマー（Issue #90）の描画と操作。判断はドメインと `Demo` に任せ、
 * ここでは状態を DOM に写し、ボタンの操作を `Demo` の呼び出しに変える（AGENTS.md §5）。
 * 文言はアプリと同じ関数（timer-text.ts など）で作るので、アプリの画面と同じ言葉になる。
 */

/** LP の知らせの音色。アプリの既定は鐘だけだが、ここでは3つのフェーズを聞き分けやすい音色にする */
const TONES: Readonly<Record<Phase["kind"], AlertTone>> = {
  Focus: "Marimba",
  Journal: "Bell",
  Break: "Soft",
};

/** 描画を更新する間隔。カウントダウンは秒単位だが、60倍速でも区切りを取りこぼさないよう短めにする */
const TICK_MS = 250;

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`LP の要素が見つからない: ${what}`);
  }
  return value;
};

const newId = () => crypto.randomUUID();

const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);

const localDate = localDateIn(Intl.DateTimeFormat().resolvedOptions().timeZone);

type Elements = Readonly<{
  app: HTMLElement;
  position: HTMLElement;
  phase: HTMLElement;
  phaseLabel: HTMLElement;
  countdown: HTMLElement;
  upcoming: HTMLElement;
  arc: SVGCircleElement;
  segments: ReadonlyArray<HTMLElement>;
  beats: ReadonlyArray<HTMLElement>;
  ops: HTMLElement;
  note: HTMLElement;
  composer: HTMLFormElement;
  body: HTMLTextAreaElement;
  send: HTMLButtonElement;
  hint: HTMLElement;
  currentDay: HTMLElement;
  today: HTMLElement;
  currentSets: HTMLElement;
  currentHead: HTMLElement;
  entries: HTMLElement;
  heroActions: HTMLElement;
  heroStatus: HTMLElement;
}>;

const elementsIn = (root: ParentNode): Elements => {
  const q = <E extends Element>(selector: string): E =>
    must(root.querySelector<E>(selector), selector);
  const app = q<HTMLElement>("[data-app]");
  return {
    app,
    position: q("[data-position]"),
    phase: q(".app-phase"),
    phaseLabel: q("[data-phase-label]"),
    countdown: q("[data-countdown]"),
    upcoming: q("[data-upcoming]"),
    arc: q<SVGCircleElement>("[data-arc]"),
    segments: [...app.querySelectorAll<HTMLElement>(".app-seg i")],
    beats: [...root.querySelectorAll<HTMLElement>("[data-beat]")],
    ops: q("[data-ops]"),
    note: q("[data-note]"),
    composer: q<HTMLFormElement>("[data-composer]"),
    body: q<HTMLTextAreaElement>("[data-body]"),
    send: q<HTMLButtonElement>("[data-send]"),
    hint: q(".app-hint"),
    currentDay: q("[data-current-day]"),
    today: q("[data-today]"),
    currentSets: q("[data-current-sets]"),
    currentHead: q("[data-current-head]"),
    entries: q("[data-entries]"),
    heroActions: q("[data-hero-actions]"),
    heroStatus: q("[data-hero-status]"),
  };
};

/** タイマーの円とセットの帯の色。アプリのフェーズの色（印の色） */
const RING_COLORS: Readonly<Record<Phase["kind"], string>> = {
  Focus: "var(--ui-focus)",
  Journal: "var(--journal-mark)",
  Break: "var(--break-mark)",
};

const fillOf = (segment: Segment): number => {
  switch (segment.kind) {
    case "Done":
      return 1;
    case "Current":
      return segment.elapsedRatio;
    case "Pending":
      return 0;
  }
};

/** 円の色とフェーズの丸の色を決める、その状態が属するフェーズ */
const phaseKindOf = (
  state: Exclude<TimerState, Readonly<{ kind: "Ended" }>>,
): Phase["kind"] | "Idle" => {
  switch (state.kind) {
    case "Focus":
    case "Journal":
    case "Break":
      return state.kind;
    case "AwaitingAdvance":
      return state.finished.kind;
    case "Idle":
      return "Idle";
  }
};

/** 残り時間・円の残り・円の下の一言 */
const dialOf = (
  state: Exclude<TimerState, Readonly<{ kind: "Ended" }>>,
  now: Date,
): Readonly<{ remainingSeconds: number; remainingRatio: number; caption: string }> => {
  switch (state.kind) {
    case "Focus":
    case "Journal":
    case "Break":
      return {
        remainingSeconds: state.remainingSeconds,
        remainingRatio: remainingRatioOf(state),
        caption:
          state.clock.kind === "Paused"
            ? pausedForLabelOf(state.clock.pausedAt, now)
            : upcomingLabelOf(upcomingPhaseOf(state)),
      };
    case "AwaitingAdvance":
      return {
        remainingSeconds: 0,
        remainingRatio: 0,
        caption: awaitingLabelOf(state.finished, state.since, now),
      };
    case "Idle":
      return {
        remainingSeconds: sessionRhythmOf().focusSeconds,
        remainingRatio: 1,
        caption: idleMessageOf(state.setNumber).title,
      };
  }
};

const labelOfOperation = (kind: SessionOperation["kind"], state: TimerState): string =>
  kind === "Advance" && state.kind === "AwaitingAdvance"
    ? advanceLabelOf(nextPhase(state.finished))
    : operationLabelOf(kind);

const EMPHASIS_CLASSES = {
  Primary: "app-button app-button-primary",
  Secondary: "app-button",
  Quiet: "app-button app-button-quiet",
} as const;

export const mountDemo = (root: ParentNode, alert: PhaseAlert, initialMode: AdvanceMode): void => {
  const el = elementsIn(root);
  let demo: Demo = Demo.initial(initialMode);
  /** 前に描いた状態。人の操作のあとは、知らせないように操作のあとの状態に置き換える */
  let previous: TimerState | undefined;
  let opsKey = "";

  el.hint.textContent = `${isMac() ? "⌘" : "Ctrl"}+Enter で送信`;
  el.today.textContent = dateLabelOf(localDate(new Date()));
  const yesterday = root.querySelector("[data-yesterday]");
  if (yesterday !== null) {
    yesterday.textContent = dateLabelOf(localDate(new Date(Date.now() - 86_400_000)));
  }

  const notify = (state: TimerState) => {
    if (previous === undefined) return;
    const change = phaseChangeBetween(previous, state);
    switch (change.kind) {
      case "PhaseChanged":
        alert.preview({ to: change.to.kind, tone: TONES[change.to.kind], volume: "Medium" });
        if (change.to.kind === "Journal" && isOnScreen(el.app)) {
          el.body.focus({ preventScroll: true });
        }
        return;
      case "Unchanged":
        return;
    }
  };

  const renderOps = (
    buttons: ReadonlyArray<
      Readonly<{ key: string; label: string; className: string; onClick: () => void }>
    >,
  ) => {
    const key = buttons.map((button) => `${button.key}:${button.label}`).join(",");
    if (key === opsKey) return;
    opsKey = key;
    el.ops.replaceChildren(
      ...buttons.map((button) => {
        const node = document.createElement("button");
        node.type = "button";
        node.className = button.className;
        node.textContent = button.label;
        node.addEventListener("click", button.onClick);
        return node;
      }),
    );
  };

  const renderDial = (state: Exclude<TimerState, Readonly<{ kind: "Ended" }>>, now: Date) => {
    const kind = phaseKindOf(state);
    const dial = dialOf(state, now);
    const { minutes, seconds } = countdownPartsOf(dial.remainingSeconds);
    el.position.textContent = positionOf(state);
    el.phase.dataset["phase"] = kind;
    el.phaseLabel.textContent = phaseLabelOf(state);
    el.countdown.textContent = `${minutes}:${seconds}`;
    el.upcoming.textContent = dial.caption;
    el.arc.style.setProperty("--ring-offset", String(1 - dial.remainingRatio));
    el.arc.style.setProperty(
      "--ring-color",
      kind === "Idle" ? "var(--ui-muted)" : RING_COLORS[kind],
    );
    const progress = roundProgressOf(state);
    [...progress.sets, progress.break].forEach((segment, i) => {
      el.segments[i]?.style.setProperty("--fill", String(fillOf(segment)));
    });
    renderBeats(rhythmBeatsOf(state));
  };

  /** ヒーローの下のリズムの帯。進めている拍に印をつける */
  const renderBeats = (fills: ReadonlyArray<number>) => {
    const current = fills.findIndex((fill) => fill > 0 && fill < 1);
    el.beats.forEach((beat, i) => {
      beat.style.setProperty("--fill", String(fills[i] ?? 0));
      beat.toggleAttribute("data-current", i === current);
    });
  };

  const renderNotStarted = () => {
    const rhythm = sessionRhythmOf();
    el.app.dataset["state"] = "NotStarted";
    el.position.textContent = "1ラウンド目・1セット目";
    el.phase.dataset["phase"] = "Focus";
    el.phaseLabel.textContent = "集中";
    const { minutes, seconds } = countdownPartsOf(rhythm.focusSeconds);
    el.countdown.textContent = `${minutes}:${seconds}`;
    el.upcoming.textContent = rhythm.set;
    el.arc.style.setProperty("--ring-offset", "0");
    el.arc.style.removeProperty("--ring-color");
    el.segments.forEach((segment) => segment.style.setProperty("--fill", "0"));
    renderBeats([]);
    el.note.textContent = rhythm.round;
    renderOps([
      { key: "Start", label: "開始", className: EMPHASIS_CLASSES.Primary, onClick: () => start(1) },
    ]);
    el.body.disabled = true;
    el.body.placeholder = "セッションを始めると書けます";
    el.send.disabled = true;
    el.currentDay.hidden = true;
    el.heroActions.hidden = false;
    el.heroStatus.hidden = true;
  };

  const renderEnded = (
    started: Extract<Demo, Readonly<{ kind: "Started" }>>,
    ended: Extract<TimerState, Readonly<{ kind: "Ended" }>>,
    now: Date,
  ) => {
    el.app.dataset["state"] = "Ended";
    const summary = SessionSummary.of({
      session: started.session,
      ended,
      now,
      entries: { kind: "Counted", count: started.entries.length },
    });
    el.position.textContent = "セッションのまとめ";
    el.phase.dataset["phase"] = "Idle";
    el.phaseLabel.textContent = phaseLabelOf(ended);
    el.countdown.textContent = focusTimeLabelOf(summary.focusTimeMs);
    el.upcoming.textContent = `${sessionSpanLabelOf(summary.startedAt, summary.endedAt)} の集中時間`;
    el.arc.style.setProperty("--ring-offset", "0");
    el.arc.style.setProperty("--ring-color", "var(--ui-muted)");
    el.segments.forEach((segment) => segment.style.setProperty("--fill", "0"));
    renderBeats([]);
    el.note.textContent = `完了 ${summary.completedSets}セット · 不成立 ${summary.abortedSets}セット · 記入 ${started.entries.length}件`;
    renderOps([
      {
        key: "Again",
        label: "もう一度はじめる",
        className: EMPHASIS_CLASSES.Primary,
        onClick: reset,
      },
    ]);
    el.body.disabled = true;
    el.body.placeholder = "セッションが終わりました";
    el.send.disabled = true;
  };

  const render = () => {
    const realNow = new Date();
    switch (demo.kind) {
      case "NotStarted":
        previous = undefined;
        renderNotStarted();
        return;
      case "Started": {
        const started = demo;
        const now = Demo.timeAt(started, realNow);
        const state = Demo.stateAt(started, realNow);
        notify(state);
        previous = state;
        el.currentDay.hidden = false;
        el.currentSets.textContent = completedSetsAndFocusTimeOf(
          Session.completedSetTimesAt(started.session, now).length,
        );
        if (state.kind === "Ended") {
          renderEnded(started, state, now);
          return;
        }
        el.app.dataset["state"] = state.kind;
        renderDial(state, now);
        el.note.textContent = currentSessionLabelOf(
          started.session.events[0].at,
          state.completedSets,
        );
        renderOps(
          operationButtonsOf(Demo.availableOperations(started, realNow)).map(
            ({ kind, emphasis }) => ({
              key: kind,
              label: labelOfOperation(kind, state),
              className: EMPHASIS_CLASSES[emphasis],
              onClick: () => operate(kind),
            }),
          ),
        );
        el.body.disabled = false;
        el.body.placeholder =
          "やったこと・次にやること・感想など（このページの外には送られません）";
        el.send.disabled = el.body.value.trim() === "";
        return;
      }
    }
  };

  const describeSpeed = (speed: number) =>
    speed === 1
      ? "実時間で動いています。7分たつと音が鳴って、ジャーナルに移ります。"
      : `${speed}倍速で動いています。集中は7秒、ジャーナルは1秒、1ラウンドは29秒です。`;

  const start = (speed: number) => {
    alert.unlockSound();
    const realNow = new Date();
    const started = Demo.start(demo, {
      sessionId: v.parse(SessionId.schema, newId()),
      eventId: v.parse(SessionEventId.schema, newId()),
      realNow,
      speed,
    });
    demo = started;
    previous = Demo.stateAt(started, realNow);
    el.entries.replaceChildren();
    el.currentHead.textContent = daySessionLabelOf(realNow);
    el.heroActions.hidden = true;
    el.heroStatus.hidden = false;
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "はじめに戻す";
    back.addEventListener("click", reset);
    el.heroStatus.replaceChildren(describeSpeed(speed), back);
    render();
  };

  const reset = () => {
    demo = Demo.reset(demo, new Date());
    el.entries.replaceChildren();
    render();
    el.heroActions.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  };

  const operate = (kind: SessionOperation["kind"]) => {
    if (demo.kind !== "Started") return;
    const realNow = new Date();
    const operated = Demo.operate(demo, {
      kind,
      eventId: v.parse(SessionEventId.schema, newId()),
      realNow,
    });
    if (Result.isSuccess(operated)) {
      demo = operated.value;
      // 人の操作で変わったフェーズは知らせない（GLOSSARY の「フェーズの切り替わり」）
      previous = Demo.stateAt(operated.value, realNow);
    }
    render();
  };

  const write = () => {
    if (demo.kind !== "Started") return;
    const body = v.safeParse(JournalEntryBody.schema, el.body.value);
    if (!body.success) return;
    const written = Demo.write(demo, {
      id: v.parse(JournalEntryId.schema, newId()),
      body: body.output,
      realNow: new Date(),
    });
    if (Result.isFailure(written)) return;
    demo = written.value;
    const [entry] = written.value.entries;
    if (entry !== undefined) {
      const item = document.createElement("li");
      item.className = "is-new";
      const meta = document.createElement("p");
      meta.className = "app-meta";
      const time = document.createElement("time");
      time.textContent = timeLabelOf(entry.writtenAt);
      const badge = document.createElement("span");
      badge.className = `app-badge app-badge-${entry.writtenDuring.kind}`;
      badge.textContent = writtenDuringBadgeOf(entry.writtenDuring);
      meta.append(time, badge);
      const text = document.createElement("p");
      text.textContent = entry.body.unwrap();
      item.append(meta, text);
      el.entries.prepend(item);
    }
    el.body.value = "";
    render();
  };

  el.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    write();
  });
  el.body.addEventListener("keydown", (event) => {
    if (shouldSubmit("ModifierEnter", event)) {
      event.preventDefault();
      write();
    }
  });
  el.body.addEventListener("input", () => {
    el.send.disabled = el.body.disabled || el.body.value.trim() === "";
  });

  root.querySelectorAll<HTMLElement>("[data-try]").forEach((button) => {
    button.addEventListener("click", () => {
      start(Number(button.dataset["try"] ?? "1"));
      if (!isOnScreen(el.app)) {
        el.app.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  });

  render();
  window.setInterval(() => {
    if (demo.kind === "Started" && !document.hidden) render();
  }, TICK_MS);
};

const isOnScreen = (element: Element): boolean => {
  const rect = element.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight;
};
