import { describe, expect, it } from "vitest";

import { ExecutionOwnershipCoordinator } from
  "../../src/task/execution_ownership_coordinator.js";

describe("ExecutionOwnershipCoordinator", () => {
  it("accepts applied=false only when the canonical owner token and phase match", () => {
    const coordinator = new ExecutionOwnershipCoordinator({} as never);
    const application = {
      eventId: 1,
      applied: false,
      canonicalSession: {} as never,
      canonicalExecutionOwnership: {
        ownershipGeneration: 17,
        ownerKind: "runner_process" as const,
        manifestId: "release-a",
        registrationId: "registration-a",
        pid: 4101,
        startIdentity: "start-4101",
        executionCommandId: "execute-a",
        phase: "active" as const,
        failureReason: null,
      },
    };

    expect(coordinator.isAppliedOrSameOwner(application, {
      ownershipGeneration: 17,
      ownerKind: "runner_process",
      manifestId: "release-a",
      registrationId: "registration-a",
      pid: 4101,
      startIdentity: "start-4101",
      executionCommandId: "execute-a",
      phases: ["active"],
    })).toBe(true);
    expect(coordinator.isAppliedOrSameOwner(application, {
      ownershipGeneration: 18,
      phases: ["active"],
    })).toBe(false);
    expect(coordinator.isAppliedOrSameOwner(application, {
      ownershipGeneration: 17,
      phases: ["identity_proven"],
    })).toBe(false);
  });
});
