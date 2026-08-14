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
});
