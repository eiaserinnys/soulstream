import { describe, expect, it } from "vitest";

import {
  COMPLETED_RESUME_TIMING_MATRIX,
  observeCompletedResumeIngress,
} from "./completed-resume-ingress-harness.js";
import { completedResumeViolations } from
  "./completed-resume-ingress-oracle.js";

describe("completed dashboard resume ingress strict RED", () => {
  it.each(COMPLETED_RESUME_TIMING_MATRIX)(
    "$label preserves dashboard intent through node execution",
    async (scenario) => {
      const observation = await observeCompletedResumeIngress(scenario);
      const violations = completedResumeViolations(observation);
      process.stdout.write(
        `COMPLETED_RESUME_RED ${scenario.label} ${JSON.stringify({ observation, violations })}\n`,
      );
      expect(violations).toEqual([]);
    },
  );

  it("proves the same composition can resume when no historical generation residue exists", async () => {
    const observation = await observeCompletedResumeIngress({
      label: "healthy-terminal-owner-cleared",
      clicks: 2,
      memoryResident: false,
      executionDrainBarrier: false,
      lastEventId: 308,
      terminalEventId: 307,
      historicalGeneration: null,
    });
    expect(completedResumeViolations(observation)).toEqual([]);
  });
});
