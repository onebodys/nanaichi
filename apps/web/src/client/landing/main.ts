import "./landing.css";
import { AdvanceMode, type PhaseTransition } from "../../domain/advance-mode.ts";
import {
  nextPhase,
  phaseDurationMsOf,
  SETS_PER_ROUND,
  type Phase,
} from "../../domain/timer-state.ts";
import { ALERT_TONES, type AlertTone } from "../alert-settings.ts";
import { timeLabelOf } from "../journal-text.ts";
import { createPhaseAlert } from "../phase-alert.ts";
import { mountDemo, type DemoView } from "./demo-view.ts";

/**
 * LP（Issue #90、ADR 0018）の入口。ログインしていない人に `/` で見せる。
 * サーバーとは通信しない。いちばん上のタイマーもページの中だけで動く（demo-view.ts）。
 */

document.documentElement.classList.add("js");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const alert = createPhaseAlert();
const demo = mountDemo(document, alert, AdvanceMode.default);

// ---------------------------------------------------------------------------
// 進め方の帯: 切り替えるといちばん上のタイマーの進め方が変わる
// ---------------------------------------------------------------------------

const isTransition = (value: string | undefined): value is PhaseTransition =>
  AdvanceMode.transitions.some((transition) => transition === value);

const mountBands = (view: DemoView) => {
  const paint = () => {
    const mode = view.modeNow();
    document.querySelectorAll<HTMLElement>("[data-transition]").forEach((band) => {
      const transition = band.dataset["transition"];
      if (!isTransition(transition)) return;
      const on = mode[transition] === "Auto";
      band.classList.toggle("is-on", on);
      band.querySelector(".switch")?.setAttribute("aria-checked", String(on));
    });
  };

  document.querySelectorAll<HTMLElement>("[data-transition]").forEach((band) => {
    const transition = band.dataset["transition"];
    if (!isTransition(transition)) return;
    band.querySelector(".switch")?.addEventListener("click", () => {
      const mode = view.modeNow();
      view.changeMode({ ...mode, [transition]: mode[transition] === "Auto" ? "Manual" : "Auto" });
      paint();
    });
  });

  const soundBand = document.querySelector<HTMLElement>("[data-sound]");
  soundBand?.classList.add("is-on");
  soundBand?.querySelector(".switch")?.addEventListener("click", (event) => {
    const on = !soundBand.classList.contains("is-on");
    soundBand.classList.toggle("is-on", on);
    if (event.currentTarget instanceof Element) {
      event.currentTarget.setAttribute("aria-checked", String(on));
    }
    view.setSound(on);
    if (on) {
      alert.preview({ to: "Journal", tone: "Bell", volume: "Medium" });
    }
  });

  paint();
};

mountBands(demo);

// ---------------------------------------------------------------------------
// 書いたものを見返す: 横に並んだ画面のうち、中央に来たものを明るくし、説明を差し替える
// ---------------------------------------------------------------------------

const SHOT_TEXTS: Readonly<Record<string, Readonly<{ name: string; text: string }>>> = {
  timeline: {
    name: "タイムラインは1本",
    text: "新しい記入が上。日付とセッションの区切りに、完了セットと集中時間が出る。スクロールすれば、そのまま過去へさかのぼれる。",
  },
  tags: {
    name: "タグをつけて書く",
    text: "入力中は、使ったことのあるタグを最近使った順に出す。つけたタグは外すまで、続けて書く記入にもつく。",
  },
  stats: {
    name: "1週間をふり返る",
    text: "集中した時間、セットの完了率、記入率、日ごとの集中。今日・週・月・すべてで切り替えられる。",
  },
  calendar: {
    name: "日付で読み返す",
    text: "月ごとのカレンダーに、日ごとの記入の数が出る。日を選ぶと、その日の記入を書いた順に読める。",
  },
  alerts: {
    name: "音色はフェーズごと",
    text: "鐘・木琴・電子音・やわらかから選ぶ。音の高さの並びはフェーズごとに決まっていて、音色を変えても聞き分けられる。試すを押すと鳴る。",
  },
};

const mountScreens = () => {
  const row = document.querySelector<HTMLElement>("[data-screens]");
  const name = document.querySelector<HTMLElement>("[data-shot-name]");
  const text = document.querySelector<HTMLElement>("[data-shot-text]");
  const caption = document.querySelector<HTMLElement>(".screens-caption");
  if (row === null || name === null || text === null || caption === null) return;
  const shots = [...row.querySelectorAll<HTMLElement>("[data-shot]")];

  let lit: HTMLElement | undefined;
  const light = (shot: HTMLElement) => {
    if (shot === lit) return;
    lit?.classList.remove("is-lit");
    shot.classList.add("is-lit");
    lit = shot;
    const copy = SHOT_TEXTS[shot.dataset["shot"] ?? ""];
    if (copy === undefined) return;
    name.textContent = copy.name;
    text.textContent = copy.text;
    caption.classList.remove("is-changing");
    void caption.offsetWidth;
    caption.classList.add("is-changing");
  };

  const centred = () => {
    const middle = row.getBoundingClientRect().left + row.clientWidth / 2;
    const nearest = shots.reduce<Readonly<{ shot: HTMLElement; distance: number }> | undefined>(
      (best, shot) => {
        const rect = shot.getBoundingClientRect();
        const distance = Math.abs(rect.left + rect.width / 2 - middle);
        return best === undefined || distance < best.distance ? { shot, distance } : best;
      },
      undefined,
    );
    if (nearest !== undefined) light(nearest.shot);
  };

  let frame = 0;
  row.addEventListener("scroll", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(centred);
  });

  // マウスでもつかんで横に動かせるようにする（指とトラックパッドはそのまま横にスクロールできる）
  let drag: Readonly<{ x: number; left: number }> | undefined;
  row.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.target instanceof HTMLButtonElement) return;
    drag = { x: event.clientX, left: row.scrollLeft };
    row.style.scrollSnapType = "none";
  });
  window.addEventListener("pointermove", (event) => {
    if (drag === undefined) return;
    row.scrollLeft = drag.left - (event.clientX - drag.x);
  });
  window.addEventListener("pointerup", () => {
    if (drag === undefined) return;
    drag = undefined;
    row.style.removeProperty("scroll-snap-type");
  });

  const centre = (shot: HTMLElement) => {
    row.scrollTo({
      left: shot.offsetLeft + shot.offsetWidth / 2 - row.clientWidth / 2,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  };

  // 画面をクリックしたら、その画面を中央に寄せる
  shots.forEach((shot) => {
    shot.addEventListener("click", () => {
      if (shot !== lit) centre(shot);
    });
  });

  // 矢印のボタンで1枚ずつ送る
  document.querySelectorAll<HTMLButtonElement>("[data-shot-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const step = Number(button.dataset["shotStep"] ?? "1");
      const index = lit === undefined ? 0 : shots.indexOf(lit);
      const next = shots[(index + step + shots.length) % shots.length];
      if (next !== undefined) centre(next);
    });
  });

  const first = shots[0];
  if (first !== undefined) light(first);
};

mountScreens();

// ---------------------------------------------------------------------------
// ジャーナルのカレンダーの見本（2026年10月、月曜始まり）。日ごとの記入の数は見本
// ---------------------------------------------------------------------------

const CALENDAR_ENTRIES: ReadonlyArray<number> = [
  6, 8, 0, 0, 9, 12, 7, 10, 4, 0, 0, 5, 9, 11, 8, 6, 0, 3,
];

const mountCalendar = () => {
  const calendar = document.querySelector("[data-calendar]");
  if (calendar === null) return;
  // 2026年10月1日は木曜日。月曜始まりなので3つ空ける
  const blanks = Array.from({ length: 3 }, () => document.createElement("span"));
  const days = Array.from({ length: 31 }, (_, i) => {
    const day = document.createElement("span");
    day.className = "panel-dayc";
    if (i + 1 === 14) day.classList.add("is-selected");
    const number = document.createElement("b");
    number.textContent = String(i + 1);
    const count = document.createElement("small");
    const entries = CALENDAR_ENTRIES[i] ?? 0;
    count.textContent = entries === 0 ? "" : String(entries);
    day.append(number, count);
    return day;
  });
  calendar.append(...blanks, ...days);
};

mountCalendar();

// ---------------------------------------------------------------------------
// 知らせ方の画面の「試す」: アプリと同じ合成の音を鳴らす
// ---------------------------------------------------------------------------

const isPhaseKind = (value: string | undefined): value is Phase["kind"] =>
  value === "Focus" || value === "Journal" || value === "Break";

const isTone = (value: string | undefined): value is AlertTone =>
  ALERT_TONES.some((tone) => tone === value);

document.querySelectorAll<HTMLButtonElement>("[data-chime]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const [to, tone] = (button.dataset["chime"] ?? "").split(":");
    if (isPhaseKind(to) && isTone(tone)) {
      alert.preview({ to, tone, volume: "Medium" });
    }
  });
});

// ---------------------------------------------------------------------------
// フッターの「いま始めると」: 最初のジャーナル・休憩・1ラウンドの終わりの時刻
// ---------------------------------------------------------------------------

const FIRST_FOCUS = { kind: "Focus", round: 1, setNumber: 1 } as const satisfies Phase;

/** 開始から、`until` のフェーズが始まるまでの時間（ミリ秒）。自動で進むものとして数える */
const msUntil = (until: (phase: Phase) => boolean): number => {
  let phase: Phase = FIRST_FOCUS;
  let ms = 0;
  for (let i = 0; i < SETS_PER_ROUND * 2 + 2 && !until(phase); i++) {
    ms += phaseDurationMsOf(phase);
    phase = nextPhase(phase);
  }
  return ms;
};

const mountClock = () => {
  const journal = document.querySelector("[data-clock-journal]");
  const breakAt = document.querySelector("[data-clock-break]");
  const round = document.querySelector("[data-clock-round]");
  if (journal === null || breakAt === null || round === null) return;
  const toJournal = msUntil((phase) => phase.kind === "Journal");
  const toBreak = msUntil((phase) => phase.kind === "Break");
  const toNextRound = msUntil((phase) => phase.kind === "Focus" && phase.round === 2);
  const paint = () => {
    const now = Date.now();
    journal.textContent = timeLabelOf(new Date(now + toJournal));
    breakAt.textContent = timeLabelOf(new Date(now + toBreak));
    round.textContent = timeLabelOf(new Date(now + toNextRound));
  };
  paint();
  window.setInterval(paint, 15_000);
};

mountClock();

// ---------------------------------------------------------------------------
// 動き: セクションに入ったら、見出し → 文 → 画面の順に入ってくる。写真はスクロールに合わせてゆっくり寄る
// ---------------------------------------------------------------------------

const mountReveal = () => {
  const items = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
  // 同じセクションの中で、順に少しずつ遅らせる
  const order = new Map<Element, number>();
  items.forEach((item) => {
    const section = item.closest("section, footer") ?? document.body;
    const i = order.get(section) ?? 0;
    item.style.setProperty("--i", String(Math.min(i, 6)));
    order.set(section, i + 1);
  });
  if (reducedMotion || !("IntersectionObserver" in window)) {
    items.forEach((item) => item.classList.add("is-in"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  items.forEach((item) => observer.observe(item));
};

const mountDrift = () => {
  if (reducedMotion) return;
  const pictures = [...document.querySelectorAll<HTMLElement>("[data-drift]")];
  let frame = 0;
  const paint = () => {
    pictures.forEach((picture) => {
      // 写真そのものは動くので、枠の位置で進み具合を測る。枠が画面の下から入って上へ抜けるまでを 0 → 1 にする
      const rect = (picture.parentElement ?? picture).getBoundingClientRect();
      const progress = Math.min(
        1,
        Math.max(0, 1 - rect.bottom / (window.innerHeight + rect.height)),
      );
      picture.style.setProperty("--drift", String(progress));
    });
  };
  window.addEventListener(
    "scroll",
    () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    },
    { passive: true },
  );
  paint();
};

/** 砂時計の映像は音のないくり返し。動きを減らす設定なら止めて、最初のコマだけを見せる */
const mountLoops = () => {
  document.querySelectorAll<HTMLVideoElement>("[data-loop]").forEach((video) => {
    if (reducedMotion) {
      video.removeAttribute("autoplay");
      video.pause();
      return;
    }
    // タブが裏にあるあいだは止めておく
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) video.pause();
      else void video.play().catch(() => undefined);
    });
  });
};

mountReveal();
mountDrift();
mountLoops();
