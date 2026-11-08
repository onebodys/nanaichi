import { goldenCases } from "../testing/golden.ts";
import { FocusTime } from "./focus-time.ts";

goldenCases(
  "FocusTime.ofCompletedSets",
  (i: Readonly<{ completedSets: number }>) => FocusTime.ofCompletedSets(i.completedSets),
  [
    {
      name: "完了セット1つにつき集中の長さ（7分）を数える",
      input: { completedSets: 10 },
      expected: 70 * 60_000,
    },
    {
      name: "完了セットがなければ集中時間は0",
      input: { completedSets: 0 },
      expected: 0,
    },
  ],
);
