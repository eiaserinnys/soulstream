import { describe, expect, it } from "vitest";

import { observeRuntimeFollowupReconnect } from
  "./runtime-followup-reconnect-wake-harness.js";
import {
  activeGenerationControlViolations,
  duplicateLifecycleControlViolations,
  noTransportControlViolations,
  runtimeFollowupMatrixViolations,
  runtimeFollowupProductCompositionViolations,
} from "./runtime-followup-reconnect-wake-oracle.js";

describe("runtime_followup reconnect and turn-end wake starvation", () => {
  it("has a satisfiable five-delivery timing matrix", async () => {
    const observation = await observeRuntimeFollowupReconnect({
      recoveryMode: "counterfactual",
    });
    expect(runtimeFollowupMatrixViolations(observation)).toEqual([]);
    expect(duplicateLifecycleControlViolations(observation)).toEqual([]);
  });

  it("keeps reconnect follow-ups pending when the transport is absent", async () => {
    const observation = await observeRuntimeFollowupReconnect({
      recoveryMode: "counterfactual",
      transportAvailable: false,
    });
    expect(noTransportControlViolations(observation)).toEqual([]);
  });

  it("does not advance an active live generation before the terminal barrier", async () => {
    const observation = await observeRuntimeFollowupReconnect({
      recoveryMode: "counterfactual",
    });
    expect(activeGenerationControlViolations(observation)).toEqual([]);
  });

  it("fresh main RED: wakes all reconnect follow-ups before turn-end cleanup", async () => {
    const observation = await observeRuntimeFollowupReconnect();
    const violations = runtimeFollowupProductCompositionViolations(observation);
    process.stdout.write(
      `RUNTIME_FOLLOWUP_RECONNECT_RED ${JSON.stringify({ observation, violations })}\n`,
    );
    expect(violations).toEqual([]);
  });
});
