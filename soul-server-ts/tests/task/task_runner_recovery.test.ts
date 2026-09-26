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
    const applyRunnerTerminalFact = vi.fn((task: Task, _fact: string, detail: string) => {
      task.status = "error";
      task.terminationReason = "error_aborted";
      task.terminationDetail = detail;
    });
    const notifyCompletionIfApplied = vi.fn();
    const recovery = subject({
      lifecycleTransition: {
        applyRunnerTerminalFact,
        persistExecutorFinalState,
        notifyCompletionIfApplied,
      } as never,
    });
    await recovery.markFailure(current, "runner exited");
    expect(persistExecutorFinalState).toHaveBeenCalledOnce();
    expect(persistExecutorFinalState).toHaveBeenCalledWith(current, true);
    expect(applyRunnerTerminalFact).toHaveBeenCalledWith(current, "reaped", "runner exited");
    expect(notifyCompletionIfApplied).toHaveBeenCalledOnce();
    expect(current).toMatchObject({ status: "error", error: "runner exited" });
    expect(current).toMatchObject({
      terminationReason: "error_aborted",
      terminationDetail: "runner exited",
    });
    expect(current.runner).toBeUndefined();
    expect(current.executionPromise).toBeUndefined();
  });

  it("does not overwrite a task that is already terminal", async () => {
    const current = task({
      status: "completed",
      result: "already completed",
      terminationReason: "completed_ok",
      terminationEventRecorded: true,
    });
    const persistExecutorFinalState = vi.fn();
    const recovery = subject({
      lifecycleTransition: {
        persistExecutorFinalState,
        notifyCompletionIfApplied: vi.fn(),
      } as never,
    });

    await recovery.markFailure(current, "late runner failure");

    expect(current).toMatchObject({
      status: "completed",
      result: "already completed",
      terminationReason: "completed_ok",
    });
    expect(persistExecutorFinalState).not.toHaveBeenCalled();
  });

  it("projects closed through the ordinary terminal transition", async () => {
    const current = task();
    const applyRunnerTerminalFact = vi.fn();
    const persistExecutorFinalState = vi.fn(async () => ({
      newlyFinalized: true,
      terminalTransitionApplied: true,
    }));
    const notifyCompletionIfApplied = vi.fn();
    const recovery = subject({
      lifecycleTransition: {
        applyRunnerTerminalFact,
        persistExecutorFinalState,
        notifyCompletionIfApplied,
      } as never,
    });
    await expect(recovery.projectClosed(current, "runner closed")).resolves.toBe(true);
    expect(applyRunnerTerminalFact).toHaveBeenCalledWith(current, "closed", "runner closed");
    expect(persistExecutorFinalState).toHaveBeenCalledWith(current, true);
    expect(notifyCompletionIfApplied).toHaveBeenCalledOnce();
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
