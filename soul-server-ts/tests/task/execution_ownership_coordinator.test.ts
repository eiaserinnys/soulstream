import { describe, expect, it, vi } from "vitest";

import { ExecutionOwnershipCoordinator } from
  "../../src/task/execution_ownership_coordinator.js";

describe("ExecutionOwnershipCoordinator", () => {
  it("serializes attach and recovery for one session while leaving other sessions independent", async () => {
    const coordinator = new ExecutionOwnershipCoordinator({} as never);
    const order: string[] = [];
    let releaseAttach!: () => void;
    const attachBlocked = new Promise<void>((resolve) => { releaseAttach = resolve; });

    const attach = coordinator.withSessionLease("session-a", "attach", async () => {
      order.push("attach:start");
      await attachBlocked;
      order.push("attach:end");
    });
    const recovery = coordinator.withSessionLease("session-a", "recovery", async () => {
      order.push("recovery");
    });
    const other = coordinator.withSessionLease("session-b", "recovery", async () => {
      order.push("other");
    });

    await vi.waitFor(() => expect(order).toEqual(["attach:start", "other"]));
    releaseAttach();
    await Promise.all([attach, recovery, other]);

    expect(order).toEqual(["attach:start", "other", "attach:end", "recovery"]);
  });

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
