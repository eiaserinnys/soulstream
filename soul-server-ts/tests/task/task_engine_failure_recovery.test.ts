import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { TaskEngineFailureRecovery } from
  "../../src/task/task_engine_failure_recovery.js";
import type { Task } from "../../src/task/task_models.js";

function makeTask(): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: "agent-1",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
  };
}

describe("TaskEngineFailureRecovery", () => {
  it("records true engine failures through one generic terminal outcome", async () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger;
    const recovery = new TaskEngineFailureRecovery({ logger });
    const task = makeTask();

    await recovery.recoverFromExecuteFailure(task, new Error("engine boom"));
    await recovery.recoverFromOuterExecutionFailure(task, new Error("prepare boom"));
    recovery.recoverFromSynthesizedFailure(task, "runtime stalled");

    expect(task).toMatchObject({
      status: "error",
      error: "runtime stalled",
      pendingTerminationHint: "error_aborted",
    });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
