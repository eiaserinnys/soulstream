import { describe, expect, it, vi } from "vitest";

import type { Task } from "../../src/task/task_models.js";
import { TaskRunnerRecovery } from "../../src/task/task_runner_recovery.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "session-1",
    prompt: "resume this turn",
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

describe("TaskRunnerRecovery", () => {
  it("hydrates an evicted runner task once and remembers it", async () => {
    const task = makeTask();
    const rememberTask = vi.fn();
    const loadTask = vi.fn().mockResolvedValue(task);
    const recovery = new TaskRunnerRecovery({
      getTask: vi.fn().mockReturnValue(undefined),
      loadTask,
      rememberTask,
      lifecycleTransition: {} as never,
      autoResumeTransition: {} as never,
    });

    await expect(recovery.hydrate(task.agentSessionId)).resolves.toBe(task);
    expect(loadTask).toHaveBeenCalledWith(task.agentSessionId);
    expect(rememberTask).toHaveBeenCalledWith(task);
  });

  it("persists an explicit runner error before resuming without a duplicate user message", async () => {
    const order: string[] = [];
    const task = makeTask({
      runner: { dispatcher: {} as never },
      runnerRetainedForClaudeBackground: true,
      executionPromise: Promise.resolve(),
      callerInfo: { source: "agent", display_name: "서소영" },
      attachmentPaths: ["/tmp/reference.png"],
      contextItems: [{ type: "text", text: "context" }],
    });
    const persistExecutorFinalState = vi.fn(async (persistedTask: Task) => {
      order.push("persist-error");
      expect(persistedTask).toMatchObject({ status: "error", error: "runner lease expired" });
      expect(persistedTask.runner).toBeUndefined();
      expect(persistedTask.runnerRetainedForClaudeBackground).toBeUndefined();
      expect(persistedTask.executionPromise).toBeUndefined();
    });
    const onResume = vi.fn();
    const resume = vi.fn(async (_task, message, callback, options) => {
      order.push("resume");
      expect(message).toMatchObject({
        text: "resume this turn",
        user: "caller-1",
        source: "runner-recovery",
        attachmentPaths: ["/tmp/reference.png"],
      });
      expect(options).toEqual({ publishUserMessage: false });
      callback(task);
      return { autoResumed: true as const };
    });
    const recovery = new TaskRunnerRecovery({
      getTask: vi.fn(),
      loadTask: vi.fn(),
      rememberTask: vi.fn(),
      lifecycleTransition: { persistExecutorFinalState } as never,
      autoResumeTransition: { resume } as never,
    });

    await recovery.markFailureAndResume(task, "runner lease expired", onResume);

    expect(order).toEqual(["persist-error", "resume"]);
    expect(onResume).toHaveBeenCalledWith(task);
  });

  it("terminalizes a replacement start that throws after the running transition", async () => {
    const task = makeTask();
    const persistExecutorFinalState = vi.fn(async () => ({
      newlyFinalized: true,
      terminalTransitionApplied: true,
    }));
    const resume = vi.fn(async (resumedTask: Task, _message, callback) => {
      resumedTask.status = "running";
      callback(resumedTask);
      return { autoResumed: true as const };
    });
    const recovery = new TaskRunnerRecovery({
      getTask: vi.fn(),
      loadTask: vi.fn(),
      rememberTask: vi.fn(),
      lifecycleTransition: { persistExecutorFinalState } as never,
      autoResumeTransition: { resume } as never,
    });

    await expect(recovery.markFailureAndResume(
      task,
      "runner exited",
      () => { throw new Error("snapshot missing"); },
    )).rejects.toThrow("snapshot missing");

    expect(persistExecutorFinalState).toHaveBeenCalledTimes(2);
    expect(task).toMatchObject({
      status: "error",
      error: "runner replacement start failed: snapshot missing",
      runner: undefined,
      executionPromise: undefined,
    });
    expect(task.completedAt).toBeInstanceOf(Date);
  });

  it("does not terminalize a running-transition rejection before the replacement callback", async () => {
    const task = makeTask();
    const persistExecutorFinalState = vi.fn(async () => ({
      newlyFinalized: true,
      terminalTransitionApplied: true,
    }));
    const recovery = new TaskRunnerRecovery({
      getTask: vi.fn(),
      loadTask: vi.fn(),
      rememberTask: vi.fn(),
      lifecycleTransition: { persistExecutorFinalState } as never,
      autoResumeTransition: {
        resume: vi.fn().mockRejectedValue(new Error("running transition rejected")),
      } as never,
    });

    await expect(recovery.markFailureAndResume(task, "runner exited", vi.fn()))
      .rejects.toThrow("running transition rejected");

    expect(persistExecutorFinalState).toHaveBeenCalledOnce();
  });

  it("does not let a stale closed projection erase a newly active owner", async () => {
    const runner = { dispatcher: {} as never };
    const executionPromise = Promise.resolve();
    const task = makeTask({
      runner,
      executionPromise,
      executionOwnership: {
        ownerKind: "spawned_runner",
        manifestId: "sha-new",
        ownershipGeneration: 42,
        registrationId: "registration-new",
        pid: 4242,
        startIdentity: "start-4242",
        executionCommandId: "execute-new",
      },
      recoveredExecutionOwnership: {
        manifestId: "sha-old",
        registrationId: "registration-old",
        pid: 4141,
        startIdentity: "start-4141",
        executionCommandId: "execute-old",
      },
    });
    const projectRecoveredRunnerTerminalFact = vi.fn();
    const recovery = new TaskRunnerRecovery({
      getTask: vi.fn(),
      loadTask: vi.fn(),
      rememberTask: vi.fn(),
      lifecycleTransition: { projectRecoveredRunnerTerminalFact } as never,
      autoResumeTransition: {} as never,
    });

    await expect(recovery.projectClosed(task, "stale closed scan")).resolves.toBe(false);

    expect(projectRecoveredRunnerTerminalFact).not.toHaveBeenCalled();
    expect(task.runner).toBe(runner);
    expect(task.executionPromise).toBe(executionPromise);
    expect(task.executionOwnership?.executionCommandId).toBe("execute-new");
  });

  it("does not emit another closed terminal fact after canonical termination", async () => {
    const task = makeTask({
      status: "completed",
      terminationEventRecorded: true,
      terminalEventId: 6240,
    });
    const projectRecoveredRunnerTerminalFact = vi.fn();
    const recovery = new TaskRunnerRecovery({
      getTask: vi.fn(),
      loadTask: vi.fn(),
      rememberTask: vi.fn(),
      lifecycleTransition: { projectRecoveredRunnerTerminalFact } as never,
      autoResumeTransition: {} as never,
    });

    await expect(recovery.projectClosed(task, "repeated closed scan")).resolves.toBe(false);
    expect(projectRecoveredRunnerTerminalFact).not.toHaveBeenCalled();
  });

  it("allows closed recovery to retry a missing terminal projection from an inactive owner", async () => {
    const task = makeTask({
      status: "error",
      terminationEventRecorded: false,
      executionOwnership: {
        ownerKind: "spawned_runner",
        manifestId: "sha-old",
        ownershipGeneration: 41,
        registrationId: "registration-old",
        pid: 4141,
        startIdentity: "start-4141",
        executionCommandId: "execute-old",
      },
      recoveredExecutionOwnership: {
        manifestId: "sha-old",
        registrationId: "registration-old",
        pid: 4141,
        startIdentity: "start-4141",
        executionCommandId: "execute-old",
      },
    });
    const projectRecoveredRunnerTerminalFact = vi.fn().mockResolvedValue(true);
    const recovery = new TaskRunnerRecovery({
      getTask: vi.fn(),
      loadTask: vi.fn(),
      rememberTask: vi.fn(),
      lifecycleTransition: { projectRecoveredRunnerTerminalFact } as never,
      autoResumeTransition: {} as never,
    });

    await expect(recovery.projectClosed(task, "retry terminal fact")).resolves.toBe(true);
    expect(projectRecoveredRunnerTerminalFact).toHaveBeenCalledOnce();
  });

  it("allows a matching closed registration to recover its stranded active owner", async () => {
    const ownership = {
      manifestId: "sha-old",
      registrationId: "registration-old",
      pid: 4141,
      startIdentity: "start-4141",
      executionCommandId: "execute-old",
    };
    const task = makeTask({
      status: "running",
      runner: { dispatcher: {} as never },
      executionOwnership: {
        ownerKind: "spawned_runner",
        ownershipGeneration: 41,
        ...ownership,
      },
      recoveredExecutionOwnership: ownership,
    });
    const projectRecoveredRunnerTerminalFact = vi.fn().mockResolvedValue(true);
    const recovery = new TaskRunnerRecovery({
      getTask: vi.fn(),
      loadTask: vi.fn(),
      rememberTask: vi.fn(),
      lifecycleTransition: { projectRecoveredRunnerTerminalFact } as never,
      autoResumeTransition: {} as never,
    });

    await expect(recovery.projectClosed(task, "matching closed owner")).resolves.toBe(true);
    expect(projectRecoveredRunnerTerminalFact).toHaveBeenCalledOnce();
    expect(task.runner).toBeUndefined();
  });
});
