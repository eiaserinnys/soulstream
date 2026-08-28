import { describe, expect, it } from "vitest";

import { observeRuntimeFollowupReconnect } from
  "./runtime-followup-reconnect-wake-harness.js";
import {
  applyDuplicateLifecycleMutation,
  applyRuntimeFollowupOracleGapMutation,
  applyRuntimeFollowupWakeMutation,
  RUNTIME_FOLLOWUP_ORACLE_GAP_MUTATIONS,
  RUNTIME_FOLLOWUP_WAKE_MUTATIONS,
  runtimeFollowupMatrixViolations,
  runtimeFollowupOracleGapViolations,
  runtimeFollowupWakeViolations,
} from "./runtime-followup-reconnect-wake-oracle.js";

describe("runtime_followup reconnect wake mutation oracle", () => {
  it("names claim exclusion, current-turn-only consume, and post-close send failure", async () => {
    const witness = await observeRuntimeFollowupReconnect({
      recoveryMode: "counterfactual",
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

    const duplicateLifecycleViolations = runtimeFollowupMatrixViolations(
      applyDuplicateLifecycleMutation(witness),
    );
    process.stdout.write(
      "RUNTIME_FOLLOWUP_RECONNECT_MUTATION duplicate_lifecycle "
        + `${JSON.stringify(duplicateLifecycleViolations)}\n`,
    );
    expect(duplicateLifecycleViolations).toEqual([
      "terminal_reconnect_duplicate_turn",
    ]);

    for (const mutation of RUNTIME_FOLLOWUP_ORACLE_GAP_MUTATIONS) {
      const violations = runtimeFollowupOracleGapViolations(
        applyRuntimeFollowupOracleGapMutation(witness, mutation),
      );
      process.stdout.write(
        `RUNTIME_FOLLOWUP_RECONNECT_ORACLE_GAP ${mutation} `
          + `${JSON.stringify(violations)}\n`,
      );
      expect(violations).toEqual([mutation]);
    }
  });
});
