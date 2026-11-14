// SessionSync.tla を TLC で検査し、それぞれの検査が期待どおりに通る・落ちるかを確かめる。
//
//   node formal/session-sync/check.mjs            既定の手数（数十秒）
//   node formal/session-sync/check.mjs --deep     手数を増やす（数分）
//   node formal/session-sync/check.mjs --only <名前>
//   node formal/session-sync/check.mjs --trace    実装のトレース（session-sync-trace.workers.test.ts）をモデルに通す
//
// Java は PATH にあればそれを、なければ mise で Temurin 21 を使う。
// TLC（tla2tools.jar）は版とハッシュを固定して ~/.cache/nanaichi-tla に取ってくる。
// TLC の出力は一時ディレクトリに残し、そのパスを表示する（/statechart で読む）。

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TLA_VERSION = "1.7.4";
const TLA_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const TLA_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar`;

const SAFETY = ["StaysLoaded", "NoTimeRollback", "NoChangeRollback", "SameTimeSameChange"];

// 既定の手数は、push のたびに走らせても困らない長さ（全部で2分ほど）に抑える。
// --deep は対象のコードを変えたときに走らせる
const bounds = (deep) =>
  deep
    ? {
        safety: { MaxChanges: 3, MaxLosses: 0, MaxDisconnects: 0 },
        faults: { MaxChanges: 2, MaxLosses: 1, MaxDisconnects: 1 },
        liveness: { MaxChanges: 2, MaxLosses: 0, MaxDisconnects: 1 },
      }
    : {
        safety: { MaxChanges: 2, MaxLosses: 0, MaxDisconnects: 0 },
        faults: { MaxChanges: 1, MaxLosses: 1, MaxDisconnects: 1 },
        liveness: { MaxChanges: 1, MaxLosses: 0, MaxDisconnects: 1 },
      };

/**
 * 検査の一覧。`expect` は通る（"pass"）か、どの性質が破れるか。
 * 壊した実装（Mutation）は、その性質が本当に落ちうることを示すためのもの。
 * 直し方の候補（Fixes）は実装にはまだない。見つかった問題がそれで消えることを示すためのもの。
 */
const checks = (deep) => {
  const b = bounds(deep);
  const safety = (name, constants, expect, properties = SAFETY) => ({
    name,
    constants: { Screens: "{s1, s2}", ...b.safety, ...constants },
    properties,
    symmetry: true,
    expect,
  });
  const liveness = (name, constants, expect) => ({
    name,
    constants: { Screens: "{s1, s2}", ...b.liveness, ...constants },
    properties: ["EventuallyConverged"],
    symmetry: false,
    expect,
  });
  const advancing = { WithWrites: "TRUE", ClockStalls: "FALSE", Mutation: '"None"', Fixes: "{}" };
  const stalling = {
    WithWrites: "TRUE",
    ClockStalls: "TRUE",
    MaxClock: deep ? 8 : 6,
    Mutation: '"None"',
    Fixes: "{}",
  };
  const held = { ...advancing, Fixes: '{"HoldSyncWhileLoading"}' };
  return [
    // 時計が要求ごとに進むなら（同じミリ秒に2つの要求がない）、安全性は3つとも成り立つ
    safety("safety", advancing, "pass"),
    // HTTP の要求・応答が失われても、WebSocket が切れて繋ぎ直しても
    safety("safety-faults", { ...advancing, ...b.faults }, "pass"),
    // 時計が止まることがあると（Workers の時計は I/O まで進まない）、前提が破れ、画面が巻き戻る
    safety("stall-same-time", stalling, "SameTimeSameChange", ["SameTimeSameChange"]),
    // 操作だけでも、別の画面の操作と同じミリ秒に処理された読み込みで巻き戻る
    safety("stall-rollback", { ...stalling, WithWrites: "FALSE" }, "NoChangeRollback", [
      "NoTimeRollback",
      "NoChangeRollback",
    ]),
    // 画面が1つでも、記入と重なった読み込みで巻き戻る（operation-overlap.ts は操作しか数えない）
    safety("stall-one-screen", { ...stalling, Screens: "{s1}" }, "NoChangeRollback", [
      "NoChangeRollback",
    ]),
    // 画面が1つで操作だけなら、時計が止まっても巻き戻らない（operation-overlap.ts が重なった読み込みを捨てる）
    safety("stall-one-screen-ops", { ...stalling, Screens: "{s1}", WithWrites: "FALSE" }, "pass", [
      "NoTimeRollback",
      "NoChangeRollback",
    ]),

    // 活性は実装のままでは成り立たない（通信が失われなくても）
    liveness("liveness", advancing, "EventuallyConverged"),
    // 読み込み中に届いた同期メッセージを待たせれば成り立つ（WebSocket が切れても）
    liveness("liveness-hold-sync", held, "pass"),
    // HTTP の応答が失われると、待たせても成り立たない
    liveness(
      "liveness-hold-sync-losses",
      { ...held, MaxLosses: 1, MaxDisconnects: 0 },
      "EventuallyConverged",
    ),

    // 壊した実装で落ちる
    safety(
      "mutant-isolder-reversed",
      { ...advancing, Mutation: '"IsOlderReversed"' },
      "NoTimeRollback",
    ),
    safety(
      "mutant-change-keeps-clock",
      { ...advancing, Mutation: '"ChangeKeepsClock"' },
      "SameTimeSameChange",
      ["SameTimeSameChange"],
    ),
    safety(
      "mutant-no-overlap-check",
      { ...stalling, Screens: "{s1}", WithWrites: "FALSE", Mutation: '"NoOverlapCheck"' },
      "NoChangeRollback",
      ["NoTimeRollback", "NoChangeRollback"],
    ),
    liveness(
      "mutant-no-refresh-on-connect",
      { ...held, Mutation: '"NoRefreshOnConnect"' },
      "EventuallyConverged",
    ),
  ];
};

const javaCommand = () => {
  const probe = spawnSync("java", ["-version"], { stdio: "ignore" });
  if (probe.status === 0) {
    return ["java"];
  }
  return ["mise", "exec", "java@temurin-21", "--", "java"];
};

const tlaJar = () => {
  const dir = join(homedir(), ".cache", "nanaichi-tla");
  const jar = join(dir, `tla2tools-${TLA_VERSION}.jar`);
  if (!existsSync(jar)) {
    mkdirSync(dir, { recursive: true });
    execFileSync("curl", ["-fsSL", "-o", jar, TLA_URL], { stdio: "inherit" });
  }
  const sha = createHash("sha256").update(readFileSync(jar)).digest("hex");
  if (sha !== TLA_SHA256) {
    throw new Error(`${jar} のハッシュが違う（${sha}）。消して取り直す`);
  }
  return jar;
};

const cfgOf = (check) =>
  [
    "CONSTANTS",
    ...Object.entries({ MaxClock: 3, ...check.constants }).map(([k, v]) => `  ${k} = ${v}`),
    "SPECIFICATION Spec",
    "INVARIANT TypeOK",
    `PROPERTIES ${check.properties.join(" ")}`,
    ...(check.symmetry ? ["SYMMETRY ScreenSymmetry"] : []),
    "CHECK_DEADLOCK FALSE",
    "",
  ].join("\n");

const runTlc = (java, jar, workDir, module, cfg) => {
  const result = spawnSync(
    java[0],
    [
      ...java.slice(1),
      "-XX:+UseParallelGC",
      "-cp",
      jar,
      "tlc2.TLC",
      "-workers",
      "auto",
      "-metadir",
      join(workDir, "states", cfg),
      "-config",
      cfg,
      module,
    ],
    { cwd: workDir, encoding: "utf8", maxBuffer: 1 << 28 },
  );
  return `${result.stdout}${result.stderr}`;
};

/** TLC の出力から、通ったか・どの性質が破れたかを読む */
const outcomeOf = (output) => {
  const violated = output.match(
    /(?:Invariant|Action property|Temporal properties?) (\w+) (?:is|was) violated/,
  );
  if (violated !== null) {
    return violated[1];
  }
  if (/Temporal properties were violated/.test(output)) {
    return "EventuallyConverged";
  }
  if (/Model checking completed\. No error has been found\./.test(output)) {
    return "pass";
  }
  return "error";
};

const statesOf = (output) =>
  [...output.matchAll(/([\d,]+) distinct states found, [\d,]+ states left on queue/g)].at(
    -1,
  )?.[1] ?? "?";

const main = () => {
  const args = process.argv.slice(2);
  const deep = args.includes("--deep");
  const onlyAt = args.indexOf("--only");
  const only = onlyAt === -1 ? undefined : args[onlyAt + 1];
  const traceOnly = args.includes("--trace");
  const java = javaCommand();
  const jar = tlaJar();
  const workDir = mkdtempSync(join(tmpdir(), "session-sync-"));
  copyFileSync(join(HERE, "SessionSync.tla"), join(workDir, "SessionSync.tla"));

  if (traceOnly) {
    process.exit(checkTraces(java, jar, workDir));
  }

  let failed = 0;
  for (const check of checks(deep).filter((c) => only === undefined || c.name === only)) {
    const cfg = `${check.name}.cfg`;
    writeFileSync(join(workDir, cfg), cfgOf(check));
    const started = Date.now();
    const output = runTlc(java, jar, workDir, "SessionSync.tla", cfg);
    writeFileSync(join(workDir, `${check.name}.out`), output);
    const outcome = outcomeOf(output);
    const ok = outcome === check.expect;
    failed += ok ? 0 : 1;
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    console.log(
      `${ok ? "ok  " : "NG  "} ${check.name.padEnd(30)} 期待: ${check.expect.padEnd(20)} 結果: ${outcome.padEnd(20)} ${statesOf(output)} states, ${seconds}s`,
    );
  }
  console.log(`\nTLC の出力: ${workDir}`);
  process.exit(failed === 0 ? 0 : 1);
};

// ---------------------------------------------------------------------------
// 実装のトレースをモデルに通す

/** JSON の値を TLA+ の値に書く。文字列は文字列、整数は整数、真偽値は TRUE / FALSE、オブジェクトはレコード */
const tlaValue = (value) => {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (Array.isArray(value)) {
    return `<<${value.map(tlaValue).join(", ")}>>`;
  }
  return `[${Object.entries(value)
    .map(([k, v]) => `${k} |-> ${tlaValue(v)}`)
    .join(", ")}]`;
};

/**
 * session-sync-trace.workers.test.ts を JSON の報告つきで走らせ、テストごとのトレース（`task.meta`）を取り出す。
 * サーバーの時刻（ミリ秒）は、大小の順だけを残してモデルの時刻（1, 2, ...）にする
 */
const tracesFromTest = (workDir) => {
  const report = join(workDir, "trace-report.json");
  const run = spawnSync(
    "pnpm",
    [
      "exec",
      "vp",
      "test",
      "run",
      "--project",
      "workers",
      "src/testing/session-sync-trace.workers.test.ts",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: join(HERE, "..", "..", "apps", "web"), encoding: "utf8" },
  );
  if (!existsSync(report)) {
    throw new Error(`トレースのテストが走らなかった\n${run.stdout}${run.stderr}`);
  }
  const results = JSON.parse(readFileSync(report, "utf8")).testResults.flatMap(
    (file) => file.assertionResults,
  );
  return results.map((result) => {
    if (result.status !== "passed" || result.meta?.sessionSyncTrace === undefined) {
      throw new Error(`トレースのテストが通らなかった: ${result.title}`);
    }
    const steps = result.meta.sessionSyncTrace;
    const times = [...new Set(steps.flatMap((s) => [s.ms, s.shownMs]).filter((ms) => ms > 0))].sort(
      (a, b) => a - b,
    );
    const rank = (ms) => (ms > 0 ? times.indexOf(ms) + 1 : 0);
    const count = (action) => steps.filter((s) => s.action === action).length;
    return {
      name: result.title,
      maxChanges: count("Operate"),
      maxLosses: 0,
      maxDisconnects: count("Disconnect"),
      maxClock: Math.max(1, times.length),
      steps: steps.map(({ ms, shownMs, ...rest }) => ({
        ...rest,
        t: rank(ms),
        shownT: rank(shownMs),
      })),
    };
  });
};

/**
 * 実装のトレースを SessionSyncTrace.tla に通す。トレースの最後まで、モデルのアクションでたどれれば一致している。
 * たどれなければ、どの手で行き詰まったかを出す
 */
const checkTraces = (java, jar, workDir) => {
  copyFileSync(join(HERE, "SessionSyncTrace.tla"), join(workDir, "SessionSyncTrace.tla"));
  let failed = 0;
  for (const [index, trace] of tracesFromTest(workDir).entries()) {
    /** `goal` 手目までモデルでたどれるか */
    const reaches = (goal, invariant) => {
      writeFileSync(
        join(workDir, "SessionSyncTraceData.tla"),
        `---- MODULE SessionSyncTraceData ----\nTrace == ${tlaValue(trace.steps)}\nGoal == ${goal}\n====\n`,
      );
      writeFileSync(join(workDir, cfg), cfgLines(invariant));
      const output = runTlc(java, jar, workDir, "SessionSyncTrace.tla", cfg);
      writeFileSync(join(workDir, `trace-${index + 1}.out`), output);
      return new RegExp(`Invariant ${invariant} is violated`).test(output);
    };
    const cfg = `trace-${index + 1}.cfg`;
    const cfgLines = (invariant) =>
      [
        "CONSTANTS",
        '  Screens = {"s1", "s2"}',
        `  MaxChanges = ${trace.maxChanges}`,
        "  WithWrites = FALSE",
        `  MaxLosses = ${trace.maxLosses}`,
        `  MaxDisconnects = ${trace.maxDisconnects}`,
        `  MaxClock = ${trace.maxClock}`,
        "  ClockStalls = TRUE",
        '  Mutation = "None"',
        "  Fixes = {}",
        "INIT TraceInit",
        "NEXT TraceNext",
        `INVARIANT ${invariant}`,
        "CHECK_DEADLOCK FALSE",
        "",
      ].join("\n");
    // 最後までたどれたら TraceUnfinished が破れる。破れなければ途中で行き詰まった
    const finished = reaches(0, "TraceUnfinished");
    failed += finished ? 0 : 1;
    if (finished) {
      console.log(
        `ok   trace-${index + 1}  ${trace.steps.length} 手をモデルでたどれた: ${trace.name}`,
      );
      continue;
    }
    // たどれた手の数を二分探索で探す（i が goal を越えれば goal 手目まで起こせた）
    let low = 0;
    let high = trace.steps.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (reaches(mid, "TraceBeforeGoal")) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    console.log(`NG   trace-${index + 1}  ${trace.name}`);
    console.log(`     ${low + 1} 手目をモデルで起こせない: ${JSON.stringify(trace.steps[low])}`);
  }
  console.log(`\nTLC の出力: ${workDir}`);
  return failed === 0 ? 0 : 1;
};

main();
