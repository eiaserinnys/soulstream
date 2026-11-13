import { describe, expect, it } from "vitest";

import { decideNodeResponse } from "../../../src/task/state/node_response_decision.js";
import type { NodeResponseFacts } from "../../../src/task/state/node_response_machine.js";
import {
  NODE_RESPONSE_ROUTES,
  NODE_WIRE_REASONS,
} from "../../../src/task/state/node_response_machine.js";

const TERMINATION: NodeResponseFacts = {
  call: "termination",
  route: "applied_false",
  reason: "none",
  registration: "same",
  termination: "absent",
  centralSession: "present",
  retained: false,
};

describe("card #1266 U2a response decision", () => {
  it("settles a termination as applied whenever the canonical termination event is ours", () => {
    for (const route of NODE_RESPONSE_ROUTES) {
      for (const reason of NODE_WIRE_REASONS) {
        for (const centralSession of ["present", "absent", "unknown"] as const) {
          const decision = decideNodeResponse({
            ...TERMINATION,
            route,
            reason,
            centralSession,
            termination: "same",
          });
          expect(decision).toEqual({ cell: "applied", reason: null, intents: [] });
        }
      }
    }
  });

  it("never closes a pending settlement without delivery for an applied termination", () => {
    const decision = decideNodeResponse({
      ...TERMINATION,
      reason: "already_terminal",
      termination: "same",
    });
    expect(decision.intents).not.toContain("close_settlement_pending");
  });

  it("does not take another call's matching projection as applied", () => {
    const decision = decideNodeResponse({
      ...TERMINATION,
      call: "resume_compensation_terminal",
      reason: "already_terminal",
      termination: "same",
    });
    expect(decision.cell).toBe("no_retry");
  });

  it("closes the settlement and releases local ownership without resubmitting when the central session is gone", () => {
    for (const route of ["no_response", "transport_retryable", "applied_false"] as const) {
      const decision = decideNodeResponse({
        ...TERMINATION,
        route,
        termination: "absent",
        centralSession: "absent",
      });
      expect(decision.intents).toEqual([
        "close_settlement_pending",
        "release_local_ownership",
      ]);
    }
    const noRetry = decideNodeResponse({
      ...TERMINATION,
      reason: "session_missing",
      centralSession: "absent",
    });
    expect(noRetry.intents).toEqual([
      "close_settlement_pending",
      "retire_rejected_registration",
      "release_local_ownership",
    ]);
  });
});
