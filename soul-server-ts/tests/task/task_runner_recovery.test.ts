import { describe, expect, it, vi } from "vitest";

import type { Task } from "../../src/task/task_models.js";
import { TaskRunnerRecovery } from "../../src/task/task_runner_recovery.js";

describe("TaskRunnerRecovery", () => {
  it("hydrates an evicted runner task once and remembers it", async () => {
    const current = task();
    const rememberTask = vi.fn();
    const loadTask = vi.fn().mockResolvedValue(current);
    const recovery = subject({ loadTask, rememberTask });
    await expect(recovery.hydrate(current.agentSessionId)).resolves.toBe(current);
    expect(rememberTask).toHaveBeenCalledWith(current);
  });

  it("persists runner failure without starting a replacement", async () => {
    const current = task({
      runner: { dispatcher: {} as never },
      executionPromise: Promise.resolve(),
    });
    const persistExecutorFinalState = vi.fn(async () => ({
      newlyFinalized: true,
      terminalTransitionApplied: true,
    }));
    const recovery = subject({ lifecycleTransition: { persistExecutorFinalState } as never });
    await recovery.markFailure(current, "runner exited");
    expect(persistExecutorFinalState).toHaveBeenCalledOnce();
    expect(current).toMatchObject({ status: "error", error: "runner exited" });
    expect(current.runner).toBeUndefined();
    expect(current.executionPromise).toBeUndefined();
  });

  it("projects closed through the ordinary terminal transition", async () => {
    const current = task();
    const applyRunnerTerminalFact = vi.fn();
    const persistExecutorFinalState = vi.fn(async () => ({
      newlyFinalized: true,
      terminalTransitionApplied: true,
    }));
    const recovery = subject({
      lifecycleTransition: { applyRunnerTerminalFact, persistExecutorFinalState } as never,
    });
    await expect(recovery.projectClosed(current, "runner closed")).resolves.toBe(true);
    expect(applyRunnerTerminalFact).toHaveBeenCalledWith(current, "closed", "runner closed");
  });

  it("does not emit another terminal fact after canonical termination", async () => {
    const current = task({
      status: "completed",
      terminationEventRecorded: true,
      terminalEventId: 6240,
    });
    const applyRunnerTerminalFact = vi.fn();
    const recovery = subject({ lifecycleTransition: { applyRunnerTerminalFact } as never });
    await expect(recovery.projectClosed(current, "repeated scan")).resolves.toBe(false);
    expect(applyRunnerTerminalFact).not.toHaveBeenCalled();
  });

  it("accepts only stable complete ownerless inventory observations", async () => {
    const current = task();
    const recovery = subject();
    const first = {
      manifestId: "sha-a",
      runtimeEnvIdentity: "env-a",
      registrationId: "registration-a",
      pid: 4123,
      startIdentity: "start-4123",
      executionCommandId: "execute-a",
      observedAt: new Date("2026-08-11T00:00:30.000Z"),
    };
    await expect(recovery.reconcileExecutionOwnershipObservations(current, {
      first,
      second: { ...first, observedAt: new Date("2026-08-11T00:00:45.000Z") },
      leaseExpiresAt: new Date("2026-08-11T00:02:45.000Z"),
    })).resolves.toBe(true);
    await expect(recovery.reconcileExecutionOwnershipObservations(current, {
      first,
      second: { ...first, registrationId: "registration-b" },
      leaseExpiresAt: new Date("2026-08-11T00:02:45.000Z"),
    })).resolves.toBe(false);
  });
});

function subject(overrides: Record<string, unknown> = {}): TaskRunnerRecovery {
  return new TaskRunnerRecovery({
    getTask: vi.fn(),
    loadTask: vi.fn(),
    rememberTask: vi.fn(),
    lifecycleTransition: {} as never,
    ...overrides,
  });
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "session-1",
    prompt: "continue",
    clientId: "caller-1",
    status: "running",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    lastEventId: 3,
    lastReadEventId: 0,
    interventionQueue: [],
    metadata: [],
    ...overrides,
  };
}
