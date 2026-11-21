import { readFile } from "node:fs/promises";

/**
 * ミューテーションテスト（`mutator --reporter agent`）の結果を、CI の Step Summary に出す Markdown にする
 * （.agents/skills/mutation-test）。生き残ったミュータントを、どのファイルのどこかと、何を何に書き換えたかで並べる。
 *
 * mutator はレポートの型を export していないので、読む項目だけをここに書く（@mizchi/mutator の dist/agent-report.d.ts）。
 */
type AgentReport = {
  scope: "diff" | "all";
  score: number;
  counts: Record<string, number>;
  gaps: ReadonlyArray<{
    gap: "notDetected" | "notInfected" | "notReached";
    file: string;
    line: number;
    column: number;
    original: string;
    replacement: string;
    key: string;
  }>;
  warnings: ReadonlyArray<{ kind: string; message: string }>;
};

const [REPORT = ".mutator/agent.json"] = process.argv.slice(2);
const report: AgentReport = JSON.parse(await readFile(REPORT, "utf8"));

const GAP_LABEL = {
  notDetected: "走るが、どのテストも落ちない（検証が弱い）",
  notInfected: "走るが、書き換えで値が変わる入力がない（境界値が足りない）",
  notReached: "どのテストも通らない",
} as const satisfies Record<AgentReport["gaps"][number]["gap"], string>;

const code = (text: string): string => {
  const line = text.replace(/\s+/g, " ");
  const short = line.length > 60 ? `${line.slice(0, 60)}…` : line;
  return `\`${short.replaceAll("`", "'").replaceAll("|", "\\|")}\``;
};

const counted = Object.entries(report.counts)
  .filter(([, count]) => count > 0)
  .map(([status, count]) => `${status} ${count}`)
  .join(" · ");

const lines = [
  "## ミューテーションテスト（domain / workflows の変えた行）",
  "",
  `スコア: ${(report.score * 100).toFixed(1)}%（${counted || "対象のミュータントなし"}）。CI は落としません。生き残りは、テストで殺すか、等価として理由つきで記録します（.agents/skills/mutation-test）。`,
  "",
  ...report.warnings.map((warning) => `> [!WARNING]\n> ${warning.kind}: ${warning.message}\n`),
];

if (report.gaps.length === 0) {
  lines.push("生き残ったミュータントはありません。");
} else {
  lines.push(
    `### 生き残ったミュータント（${report.gaps.length}）`,
    "",
    "| 場所 | 書き換え | 見落とし | key |",
    "| --- | --- | --- | --- |",
    ...report.gaps.map(
      (gap) =>
        `| \`${gap.file}:${gap.line}:${gap.column}\` | ${code(gap.original)} → ${code(gap.replacement)} | ${GAP_LABEL[gap.gap]} | \`${gap.key}\` |`,
    ),
  );
}

console.log(lines.join("\n"));
