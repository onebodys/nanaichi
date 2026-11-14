// AutoEndAlarm.tla を TLC で検査する（Issue #35、.agents/skills/auto-end-alarm）。
//
//   node specs/auto-end-alarm/check.mjs          # 既定の範囲（数秒）
//   node specs/auto-end-alarm/check.mjs --deep   # 実装どおりのモデルだけ広い範囲で（十数秒）
//
// 1. 実装どおりのモデルで、すべての性質が成り立つ
// 2. 壊したモデルで、それぞれの性質が落ちる（落ちるのを見ていない検査は何も証明しない）
// 3. 本物の UserDO のトレース（traces/*.json）をモデルが受け入れる
//
// TLC は版と SHA-256 を固定して node_modules/.cache/tla2tools/ に取ってくる。Java 11 以上が要る。
// Java が見つからなければ終了コード 3 で終わる（scripts/tla-check-if-changed.sh が飛ばす）
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SPEC_DIR, "../..");
const TLA_VERSION = "1.7.4";
const TLA_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const JAR = join(ROOT, "node_modules/.cache/tla2tools", `tla2tools-${TLA_VERSION}.jar`);

/** 実装どおりのモデルの範囲。.agents/skills/auto-end-alarm の「範囲と前提」と合わせる */
const BOUNDS = {
  RequestUntil: 3,
  MaxDue: 5,
  MaxRequests: 3,
  MaxFailures: 2,
  AlarmRetries: 6,
  Bug: '"None"',
};

/** --deep の範囲。失敗は Cloudflare の再試行の回数まで続けてよい */
const DEEP_BOUNDS = { RequestUntil: 5, MaxDue: 8, MaxRequests: 5, MaxFailures: 6 };
const DEEP = process.argv.includes("--deep");

const INVARIANTS = ["NotClosedBeforeDue", "ScheduledInFuture", "OpenSessionIsWatched"];
const PROPERTIES = ["EventuallyClosed"];

/** 壊したモデルと、それで落ちるべき性質。.agents/skills/auto-end-alarm の表と合わせる */
const BROKEN = [
  {
    name: "要求では張り直さない（開始のときだけ張る）",
    bounds: { Bug: '"RearmOnlyOnStart"' },
    fails: "EventuallyClosed",
  },
  {
    name: "要求では張り直さない（開始のときだけ張る）",
    bounds: { Bug: '"RearmOnlyOnStart"' },
    fails: "OpenSessionIsWatched",
  },
  {
    name: "トランザクションと setAlarm の間に await を挟む",
    bounds: { Bug: '"SplitCommit"', MaxRequests: 2 },
    fails: "EventuallyClosed",
  },
  {
    name: "Ended の判定を `>=` から `>` にする",
    bounds: { Bug: '"OffByOne"' },
    fails: "ScheduledInFuture",
  },
  {
    name: "alarm() が状態を見ずに閉じる",
    bounds: { Bug: '"CloseOnAlarm"' },
    fails: "NotClosedBeforeDue",
  },
  {
    name: "alarm() が Cloudflare の再試行の回数（6）を超えて続けて失敗する",
    bounds: { MaxFailures: 7 },
    fails: "EventuallyClosed",
  },
];

const findJava = () => {
  const candidates = [
    process.env.JAVA_HOME && join(process.env.JAVA_HOME, "bin/java"),
    "java",
    "/opt/homebrew/opt/openjdk/bin/java",
    "/usr/local/opt/openjdk/bin/java",
  ].filter(Boolean);
  // macOS の /usr/bin/java は Java がなくても存在し、-version で失敗する
  const java = candidates.find((c) => spawnSync(c, ["-version"], { stdio: "ignore" }).status === 0);
  if (java === undefined) {
    console.error(
      "Java が見つかりません。Java 11 以上を入れてください（macOS なら `brew install openjdk`）",
    );
    process.exit(3);
  }
  return java;
};

const ensureJar = () => {
  if (!existsSync(JAR)) {
    mkdirSync(dirname(JAR), { recursive: true });
    const url = `https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar`;
    console.log(`TLC ${TLA_VERSION} を取ってきます: ${url}`);
    execFileSync("curl", ["-fsSL", "-o", JAR, url], { stdio: "inherit" });
  }
  const digest = createHash("sha256").update(readFileSync(JAR)).digest("hex");
  if (digest !== TLA_SHA256) {
    console.error(`${JAR} の SHA-256 が合いません（${digest}）。消してから走らせ直してください`);
    process.exit(2);
  }
};

const cfg = ({ specification, bounds, invariants, properties, checkDeadlock }) =>
  [
    `SPECIFICATION ${specification}`,
    "CONSTANTS",
    ...Object.entries(bounds).map(([k, v]) => `    ${k} = ${v}`),
    ...(invariants.length > 0 ? ["INVARIANTS", ...invariants.map((n) => `    ${n}`)] : []),
    ...(properties.length > 0 ? ["PROPERTIES", ...properties.map((n) => `    ${n}`)] : []),
    `CHECK_DEADLOCK ${checkDeadlock ? "TRUE" : "FALSE"}`,
    "",
  ].join("\n");

/** 一時ディレクトリに spec を写して TLC を走らせ、出力を返す。`extra` は追加で置くモジュール */
const tlc = (java, { module, config, extra = {} }) => {
  const dir = mkdtempSync(join(tmpdir(), "auto-end-alarm-"));
  for (const f of ["AutoEndAlarm.tla", "TraceAutoEndAlarm.tla"])
    copyFileSync(join(SPEC_DIR, f), join(dir, f));
  for (const [f, text] of Object.entries(extra)) writeFileSync(join(dir, f), text);
  writeFileSync(join(dir, `${module}.cfg`), config);
  const args = [
    "-XX:+UseParallelGC",
    "-cp",
    JAR,
    "tlc2.TLC",
    "-workers",
    "1",
    "-metadir",
    join(dir, "states"),
  ];
  return new Promise((resolve) => {
    const child = spawn(java, [...args, "-config", `${module}.cfg`, `${module}.tla`], { cwd: dir });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", () => resolve(output));
  });
};

const violated = (output) => {
  const invariant = output.match(/Error: Invariant (\w+) is violated/);
  if (invariant) return invariant[1];
  if (output.includes("Temporal properties were violated")) return "temporal";
  if (output.includes("Error: Deadlock reached")) return "deadlock";
  return output.includes("Model checking completed. No error has been found.") ? null : "error";
};

const distinct = (output) =>
  [...output.matchAll(/([\d,]+) distinct states found/g)].at(-1)?.[1] ?? "?";

const tlaValue = (value) => {
  if (value === null) return '[kind |-> "Unset"]';
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
};

/** traces/*.json の1つを TraceData.tla にする */
const traceModule = (trace) => {
  const step = (s) =>
    `[kind |-> ${tlaValue(s.kind)}, op |-> ${tlaValue(s.op ?? "Read")}, now |-> ${s.now}, ` +
    `open |-> ${tlaValue(s.after.open)}, autoEnded |-> ${s.after.autoEnded}, ` +
    `alarm |-> ${s.after.alarm === null ? '[kind |-> "Unset"]' : `[kind |-> "Set", at |-> ${s.after.alarm}]`}]`;
  return `---- MODULE TraceData ----\nTrace == <<\n  ${trace.steps.map(step).join(",\n  ")}\n>>\n====\n`;
};

const modelCheck = (bounds, invariants, properties) => ({
  module: "AutoEndAlarm",
  config: cfg({
    specification: "Spec",
    bounds: { ...BOUNDS, ...bounds },
    invariants,
    properties,
    checkDeadlock: false,
  }),
});

const traceCheck = (trace) => ({
  module: "TraceAutoEndAlarm",
  config: cfg({
    specification: "TraceSpec",
    bounds: BOUNDS,
    invariants: ["NotClosedBeforeDue", "ScheduledInFuture"],
    properties: [],
    checkDeadlock: true,
  }),
  extra: { "TraceData.tla": traceModule(trace) },
});

/** トレースが受け入れられなかったとき、一致しなかった歩を示す（i は一致した歩の数） */
const unmatchedStep = (trace) => (output) => {
  const matched = [...output.matchAll(/^\/\\ i = (\d+)$/gm)].map((m) => Number(m[1]));
  const i = matched.length > 0 ? Math.max(...matched) : 0;
  return `${i + 1} 歩目がモデルと一致しない: ${JSON.stringify(trace.steps[i])}`;
};

const traceDir = join(SPEC_DIR, "traces");
const traces = readdirSync(traceDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((file) => ({ file, trace: JSON.parse(readFileSync(join(traceDir, file), "utf8")) }));

// トレースの照合が落ちうることも確かめる。終了の操作のあとも alarm が残っていた、という偽のトレース
const tampered = (() => {
  const { trace } = traces.find(({ file }) => file === "end-and-restart.json");
  const endAt = trace.steps.findIndex((s) => s.op === "End");
  const steps = trace.steps.map((s, k) =>
    k === endAt ? { ...s, after: { ...s.after, alarm: trace.steps[k - 1].after.alarm } } : s,
  );
  return { ...trace, steps };
})();

const jobs = [
  {
    title: `実装どおりのモデル${DEEP ? "（--deep）" : ""}で ${[...INVARIANTS, ...PROPERTIES].join(", ")} が成り立つ`,
    run: modelCheck(DEEP ? DEEP_BOUNDS : {}, ["TypeOK", ...INVARIANTS], PROPERTIES),
    expect: null,
  },
  ...BROKEN.map((broken) => {
    const temporal = PROPERTIES.includes(broken.fails);
    return {
      title: `壊したモデル「${broken.name}」で ${broken.fails} が落ちる`,
      run: modelCheck(
        broken.bounds,
        temporal ? [] : [broken.fails],
        temporal ? [broken.fails] : [],
      ),
      expect: temporal ? "temporal" : broken.fails,
    };
  }),
  ...traces.map(({ file, trace }) => ({
    title: `実装のトレース ${file}（${trace.steps.length} 歩）をモデルが受け入れる`,
    run: traceCheck(trace),
    expect: null,
    explain: unmatchedStep(trace),
  })),
  {
    title: "偽のトレース（終了の操作のあとも alarm が残る）をモデルが受け入れない",
    run: traceCheck(tampered),
    expect: "deadlock",
  },
];

const java = findJava();
ensureJar();

const results = [];
let next = 0;
const worker = async () => {
  while (next < jobs.length) {
    const k = next++;
    results[k] = await tlc(java, jobs[k].run);
  }
};
await Promise.all(Array.from({ length: Math.min(jobs.length, availableParallelism()) }, worker));

let failed = false;
jobs.forEach((job, k) => {
  const output = results[k];
  const ok = violated(output) === job.expect;
  const states =
    job.expect === null && job.run.module === "AutoEndAlarm" ? `（${distinct(output)} 状態）` : "";
  console.log(`${ok ? "ok  " : "FAIL"} ${job.title}${states}`);
  if (!ok) {
    failed = true;
    if (job.explain) console.log(`     ${job.explain(output)}`);
    const lines = output.split("\n").filter((l) => !l.startsWith("Progress") && l.trim() !== "");
    console.log(lines.slice(-60).join("\n"));
  }
});

process.exit(failed ? 1 : 0);
