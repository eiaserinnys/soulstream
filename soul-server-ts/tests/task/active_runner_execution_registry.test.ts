import { describe, expect, it } from "vitest";

import { ActiveRunnerExecutionRegistry } from
  "../../src/task/active_runner_execution_registry.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import type { Task } from "../../src/task/task_models.js";

describe("ActiveRunnerExecutionRegistry", () => {
  it("matches the exact registration identity and protects unreadable sessions", () => {
    const registry = new ActiveRunnerExecutionRegistry();
    const task = { agentSessionId: "session-a" } as Task;
    const promise = new Promise<void>(() => {});
    const runner = {} as TaskRunnerRuntime;
    task.executionPromise = promise;
    registry.track(task, promise);
    registry.attach(task, runner);
    registry.bindOwnership(task, {
      ownerKind: "runner_process",
      manifestId: "release-a",
      runtimeEnvIdentity: "env-a",
      ownershipGeneration: 7,
      registrationId: "registration-a",
      pid: 1234,
      startIdentity: "start-1234",
      executionCommandId: "execute-a",
    });

    expect(registry.missingRegistrations([{
      sessionId: "session-a",
      registrationId: "registration-a",
    }])).toEqual([]);
    expect(registry.missingRegistrations([{
      sessionId: "session-a",
      registrationId: null,
    }])).toEqual([]);
    expect(registry.missingRegistrations([{
      sessionId: "session-a",
      registrationId: "replacement-registration",
    }])).toEqual([
      expect.objectContaining({ task, promise, runner }),
    ]);
  });
});
