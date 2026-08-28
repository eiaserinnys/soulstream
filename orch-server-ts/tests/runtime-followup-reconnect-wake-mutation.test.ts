import { describe, expect, it } from "vitest";

import {
  composePendingImmediateClaim,
  observeRuntimeFollowupReconnect,
} from
  "./runtime-followup-reconnect-wake-harness.js";
import {
  applyDuplicateLifecycleMutation,
  applyPublicClaimStructuralOracleHiddenMutation,
  applyRuntimeFollowupOracleGapMutation,
  applyRuntimeFollowupWakeMutation,
  publicClaimCompositionViolations,
  RUNTIME_FOLLOWUP_ORACLE_GAP_MUTATIONS,
  RUNTIME_FOLLOWUP_STRUCTURAL_ORACLE_MUTATION,
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

    const legacyCalls: string[] = [];
    const legacyOnly = composePendingImmediateClaim({
      claimPendingHumanLiveSteerForNode: async () => {
        legacyCalls.push("legacy");
        return [];
      },
    });
    await legacyOnly.claim("node", "lease");
    expect(legacyCalls).toEqual(["legacy"]);
    expect(publicClaimCompositionViolations(legacyOnly.observation)).toEqual([]);

    const generalizedCalls: string[] = [];
    const generalizedOnly = composePendingImmediateClaim({
      claimPendingImmediateIntentsForNode: async () => {
        generalizedCalls.push("generalized");
        return [];
      },
    });
    await generalizedOnly.claim("node", "lease");
    expect(generalizedCalls).toEqual(["generalized"]);
    expect(publicClaimCompositionViolations(
      generalizedOnly.observation,
    )).toEqual([]);

    const bothCalls: string[] = [];
    const bothEntries = composePendingImmediateClaim({
      claimPendingImmediateIntentsForNode: async () => {
        bothCalls.push("generalized");
        return [];
      },
      claimPendingHumanLiveSteerForNode: async () => {
        bothCalls.push("legacy");
        return [];
      },
    });
    await bothEntries.claim("node", "lease");
    expect(bothCalls).toEqual(["generalized"]);
    expect(publicClaimCompositionViolations(bothEntries.observation)).toEqual([
      "duplicate_public_claim_entry",
    ]);

    const hiddenStructuralViolations = publicClaimCompositionViolations(
      applyPublicClaimStructuralOracleHiddenMutation(bothEntries.observation),
    );
    process.stdout.write(
      `RUNTIME_FOLLOWUP_RECONNECT_STRUCTURAL_MUTATION `
        + `${RUNTIME_FOLLOWUP_STRUCTURAL_ORACLE_MUTATION} `
        + `${JSON.stringify(hiddenStructuralViolations)}\n`,
    );
    expect(hiddenStructuralViolations).toEqual([
      RUNTIME_FOLLOWUP_STRUCTURAL_ORACLE_MUTATION,
    ]);
  });
});
