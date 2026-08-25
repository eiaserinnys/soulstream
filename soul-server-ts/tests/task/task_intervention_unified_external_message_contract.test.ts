import { describe, expect, it } from "vitest";

import { observeUniversalExternalMessageContract } from
  "./task_intervention_unified_external_message_harness.js";
import {
  applyUnifiedRouteMutation,
  idealUnifiedExternalMessageObservation,
  readUnifiedRouteMutation,
  UNIFIED_ROUTE_MUTATIONS,
  type UnifiedRouteMutation,
  unifiedExternalMessageViolations,
} from "./task_intervention_unified_external_message_oracle.js";

const MUTATION = readUnifiedRouteMutation(
  process.env.SOULSTREAM_E_UNIFIED_ROUTE_MUTATION,
);
const MUTATION_SENTINELS: Record<UnifiedRouteMutation, string> = {
  intent_queue_only: "running_route_not_universal:claude:human_live_steer",
  source_queue_only: "running_route_not_universal:claude:delegated_explicit_report",
  backend_passive_wait: "codex_active_turn_not_immediate:legacy",
  human_only_special_case:
    "running_route_not_universal:claude:delegated_explicit_report",
  passive_wait_until_natural_complete:
    "claude_next_turn_not_immediate:human_live_steer",
  duplicate_delivery_identity:
    "delivery_identity_not_exactly_once:81000000-0000-4000-8000-000000000001",
};

describe("universal external-message routing contract", () => {
  it("is reachable with one idle/running branch and no taxonomy exception", () => {
    expect(unifiedExternalMessageViolations(
      idealUnifiedExternalMessageObservation(),
    )).toEqual([]);
  });

  it.each(UNIFIED_ROUTE_MUTATIONS)(
    "turns a passing observation RED under %s",
    (mutation) => {
      const violations = unifiedExternalMessageViolations(
        applyUnifiedRouteMutation(
          idealUnifiedExternalMessageObservation(),
          mutation,
        ),
      );
      process.stdout.write(
        `E_UNIVERSAL_MUTATION ${mutation} ${JSON.stringify(violations)}\n`,
      );
      expect(violations).toContain(MUTATION_SENTINELS[mutation]);
      expect(violations.length).toBeGreaterThan(0);
    },
  );

  it("fresh main RED: every external message is immediately seen by idle or running agent", async () => {
    const baseline = await observeUniversalExternalMessageContract();
    const observed = applyUnifiedRouteMutation(baseline, MUTATION);
    const violations = unifiedExternalMessageViolations(observed);
    process.stdout.write(
      `E_UNIVERSAL_ROUTE_ORACLE (${MUTATION ?? "baseline"}) `
        + `${JSON.stringify(violations)}\n`,
    );
    expect(
      violations,
      `universal route violations (${MUTATION ?? "baseline"}): `
        + `${JSON.stringify(violations)}\n${JSON.stringify(observed, null, 2)}`,
    ).toEqual([]);
  });
});
