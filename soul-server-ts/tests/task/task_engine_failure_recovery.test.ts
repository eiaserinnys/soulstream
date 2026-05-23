import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { TaskEngineFailureRecovery } from "../../src/task/task_engine_failure_recovery.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

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
  const emitEventEnvelope = vi.fn(async () => undefined);
  const broadcaster = { emitEventEnvelope } as unknown as SessionBroadcaster;
  const logger = {
    warn: vi.fn(),
  } as unknown as Logger;
  const recovery = new TaskEngineFailureRecovery({
    broadcaster,
    logger,
  });

  return {
    emitEventEnvelope,
    logger,
    recovery,
  };
}

describe("TaskEngineFailureRecovery", () => {
  it("records engine errors on running tasks", async () => {
    const { emitEventEnvelope, recovery } = makeRecovery();
    const task = makeTask();

    await recovery.recoverFromExecuteFailure(task, new Error("engine boom"));

    expect(task.status).toBe("error");
    expect(task.error).toBe("engine boom");
    expect(emitEventEnvelope).not.toHaveBeenCalled();
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

  it("clears skipped queued interventions and broadcasts a wire-only error", async () => {
    const { emitEventEnvelope, recovery } = makeRecovery();
    const task = makeTask({
      interventionQueue: [
        { text: "first", user: "u" },
        { text: "second", user: "u" },
      ],
    });

    await recovery.recoverFromExecuteFailure(task, new Error("engine boom"));

    expect(task.interventionQueue).toEqual([]);
    expect(emitEventEnvelope).toHaveBeenCalledWith("sess-1", {
      type: "error",
      message: "Turn failed; 2 queued intervention(s) skipped",
      fatal: false,
    });
  });

  it("isolates skipped-intervention broadcast failure after clearing the queue", async () => {
    const { emitEventEnvelope, logger, recovery } = makeRecovery();
    emitEventEnvelope.mockRejectedValueOnce(new Error("upstream down"));
    const task = makeTask({
      interventionQueue: [{ text: "pending", user: "u" }],
    });

    await expect(
      recovery.recoverFromExecuteFailure(task, new Error("engine boom")),
    ).resolves.toBeUndefined();

    expect(task.interventionQueue).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
        sessionId: "sess-1",
      },
      "queue-skipped error broadcast failed",
    );
  });
});
