import { describe, expect, it } from "vitest";

import { observeCompletedResumeIngress } from
  "./completed-resume-ingress-harness.js";
import {
  applyCompletedResumeMutation,
  COMPLETED_RESUME_MUTATIONS,
  completedResumeViolations,
} from "./completed-resume-ingress-oracle.js";

describe("completed resume ingress mutation oracle", () => {
  it("rejects every required loss or duplication mutation", async () => {
    const witness = await observeCompletedResumeIngress({
      label: "mutation-witness",
      clicks: 2,
      memoryResident: true,
      executionDrainBarrier: false,
      lastEventId: 308,
      terminalEventId: 307,
      historicalGeneration: null,
    });
    expect(completedResumeViolations(witness)).toEqual([]);

    for (const mutation of COMPLETED_RESUME_MUTATIONS) {
      const violations = completedResumeViolations(
        applyCompletedResumeMutation(witness, mutation),
      );
      process.stdout.write(
        `COMPLETED_RESUME_MUTATION ${mutation} ${JSON.stringify(violations)}\n`,
      );
      expect(violations.length).toBeGreaterThan(0);
    }
  });
});
