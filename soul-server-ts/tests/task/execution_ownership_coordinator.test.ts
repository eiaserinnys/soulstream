import { describe, expect, it, vi } from "vitest";

import { ExecutionOwnershipCoordinator } from
  "../../src/task/execution_ownership_coordinator.js";

describe("ExecutionOwnershipCoordinator", () => {
  it("exposes one sessions-row acquire admission boundary", async () => {
    const application = {
      eventId: 1,
      applied: true,
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
    const acquireExecutionOwnershipAndWaitForApplication = vi.fn(
      async () => application,
    );
    const coordinator = new ExecutionOwnershipCoordinator({
      acquireExecutionOwnershipAndWaitForApplication,
    } as never);
    const input = {
      ownerKind: "runner_process",
      manifestId: "release-a",
      runtimeEnvIdentity: "env-a",
      registrationId: "registration-a",
      pid: 4101,
      startIdentity: "start-4101",
      executionCommandId: "execute-a",
      leaseExpiresAt: new Date("2026-08-27T00:01:00.000Z"),
      reviewState: "not_required",
    };

    await expect(coordinator.acquire("sess-1", input)).resolves.toBe(application);
    expect(acquireExecutionOwnershipAndWaitForApplication)
      .toHaveBeenCalledWith("sess-1", input);
  });
});
