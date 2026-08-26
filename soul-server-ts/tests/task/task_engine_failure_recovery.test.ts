import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { TaskEngineFailureRecovery } from "../../src/task/task_engine_failure_recovery.js";
import type { Task } from "../../src/task/task_models.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: "agent-1",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeRecovery() {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;
  const recovery = new TaskEngineFailureRecovery({
    logger,
  });

  return {
    logger,
    recovery,
  };
}

describe("TaskEngineFailureRecovery", () => {
  it("records engine errors on running tasks", async () => {
    const { recovery } = makeRecovery();
    const task = makeTask({ result: "stale success" });

    await recovery.recoverFromExecuteFailure(task, new Error("engine boom"));

    expect(task.status).toBe("error");
    expect(task.error).toBe("engine boom");
    expect(task.result).toBeUndefined();
    expect(task.pendingTerminationHint).toBe("error_aborted");
    expect(task.pendingTerminationDetail).toBe("engine boom");
  });

  it("does not overwrite a non-running status while recovering", async () => {
    const { recovery } = makeRecovery();
    const task = makeTask({
      status: "interrupted",
      error: "already interrupted",
    });

    await recovery.recoverFromExecuteFailure(task, new Error("engine boom"));

    expect(task.status).toBe("interrupted");
    expect(task.error).toBe("already interrupted");
  });

  it("preserves queued interventions when the active turn fails", async () => {
    const { recovery } = makeRecovery();
    const task = makeTask({
      interventionQueue: [
        { text: "first", user: "u" },
        { text: "second", user: "u" },
      ],
    });

    await recovery.recoverFromExecuteFailure(task, new Error("engine boom"));

    expect(task.interventionQueue).toEqual([
      { text: "first", user: "u" },
      { text: "second", user: "u" },
    ]);
  });

  it("records a real engine failure without consuming queued input", async () => {
    const { recovery } = makeRecovery();
    const task = makeTask({
      interventionQueue: [{ text: "pending", user: "u" }],
    });

    await expect(
      recovery.recoverFromExecuteFailure(task, new Error("engine boom")),
    ).resolves.toBe("stop_on_error");

    expect(task.interventionQueue).toEqual([{ text: "pending", user: "u" }]);
  });

  it("recovers outer execution failures without deleting queued interventions", async () => {
    const { logger, recovery } = makeRecovery();
    const task = makeTask({
      status: "interrupted",
      error: "already interrupted",
      result: "stale success",
      interventionQueue: [{ text: "pending", user: "u" }],
    });

    await recovery.recoverFromOuterExecutionFailure(task, new Error("prepare boom"));

    expect(task.status).toBe("error");
    expect(task.error).toBe("prepare boom");
    expect(task.result).toBeUndefined();
    expect(task.pendingTerminationHint).toBe("error_aborted");
    expect(task.pendingTerminationDetail).toBe("prepare boom");
    expect(task.interventionQueue).toEqual([{ text: "pending", user: "u" }]);
    expect(logger.error).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
        sessionId: "sess-1",
      },
      "Task execution threw outside event stream",
    );
  });

  it("records synthesized fatal failures through the same terminal owner", () => {
    const { recovery } = makeRecovery();
    const task = makeTask({ result: "stale success" });

    recovery.recoverFromSynthesizedFailure(task, "runtime stalled");

    expect(task.status).toBe("error");
    expect(task.error).toBe("runtime stalled");
    expect(task.result).toBeUndefined();
    expect(task.pendingTerminationHint).toBe("error_aborted");
    expect(task.pendingTerminationDetail).toBe("runtime stalled");
  });
});
