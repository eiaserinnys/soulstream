import { describe, expect, it } from "vitest";

import { observeRuntimeFollowupReconnect } from
  "./runtime-followup-reconnect-wake-harness.js";
import {
  applyRuntimeFollowupWakeMutation,
  RUNTIME_FOLLOWUP_WAKE_MUTATIONS,
  runtimeFollowupWakeViolations,
} from "./runtime-followup-reconnect-wake-oracle.js";

describe("runtime_followup reconnect wake mutation oracle", () => {
  it("names claim exclusion, current-turn-only consume, and post-close send failure", async () => {
    const witness = await observeRuntimeFollowupReconnect({
      recoveryMode: "counterfactual_runtime_claim",
      socketCloseRace: false,
    });
    expect(runtimeFollowupWakeViolations(witness)).toEqual([]);

    for (const mutation of RUNTIME_FOLLOWUP_WAKE_MUTATIONS) {
      const violations = runtimeFollowupWakeViolations(
        applyRuntimeFollowupWakeMutation(witness, mutation),
      );
      process.stdout.write(
        `RUNTIME_FOLLOWUP_RECONNECT_MUTATION ${mutation} `
          + `${JSON.stringify(violations)}\n`,
      );
      expect(violations).toEqual([mutation]);
    }
  });
});
