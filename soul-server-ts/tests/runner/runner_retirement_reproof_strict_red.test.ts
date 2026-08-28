import { describe, expect, it } from "vitest";

import {
  observeConcurrentScanAndExplicitResume,
  observeFalseDeadBecomesLiveAtRetireLock,
  observeFsFailureDuringRetirement,
  observeNaturalExitBeforeSignal,
  observeRestartAfterSigtermBeforeExitProof,
} from "./runner_retirement_reproof_harness.js";
import {
  idealRetirementReproofObservation,
  retirementReproofViolations,
  type RetirementReproofObservation,
} from "./runner_retirement_reproof_oracle.js";

const productRows: Array<{
  row: 4 | 5 | 6 | 7 | 8;
  name: string;
  observe(): Promise<RetirementReproofObservation>;
}> = [
  {
    row: 4,
    name: "scan false-dead 뒤 retire lock 경계에서 live면 exact reproof→terminate→exit proof 뒤 retire한다",
    observe: observeFalseDeadBecomesLiveAtRetireLock,
  },
  {
    row: 5,
    name: "signal 직전 자연 종료는 unrelated PID에 signal하지 않고 death proof 뒤 retire한다",
    observe: observeNaturalExitBeforeSignal,
  },
  {
    row: 6,
    name: "SIGTERM 뒤 host restart는 exact registration을 보존하고 다음 host가 종료를 완결한다",
    observe: observeRestartAfterSigtermBeforeExitProof,
  },
  {
    row: 7,
    name: "retire FS 실패는 identity·pid·socket evidence를 보존하고 explicit retry로 수렴한다",
    observe: observeFsFailureDuringRetirement,
  },
  {
    row: 8,
    name: "recovery scan과 explicit resume는 같은 mutation lock에서 retire→spawn을 exactly once 직렬화한다",
    observe: observeConcurrentScanAndExplicitResume,
  },
];

describe("runner retirement final liveness reproof strict RED", () => {
  it("rows 1-10 share one invariant oracle and an ideal baseline", () => {
    for (const row of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const) {
      expect(retirementReproofViolations(idealRetirementReproofObservation(row))).toEqual([]);
    }
  });

  it.each(productRows)("row $row: $name", async ({ row, observe }) => {
    const observation = await observe();
    const violations = retirementReproofViolations(observation);
    console.info(
      `[retirement-reproof strict RED row ${row}]`,
      JSON.stringify({ observation, violations }),
    );
    expect(violations).toEqual([]);
  });
});
