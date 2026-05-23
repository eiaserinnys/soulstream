import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  ActiveTaskRecovery,
  classifyInterventionTaskActivity,
} from "../../src/task/task_active_recovery.js";
import type { Task } from "../../src/task/task_models.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "s1",
    prompt: "original prompt",
    status: "running",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 3,
    interventionQueue: [],
    ...overrides,
  };
}

function makeLogger() {
  return { warn: vi.fn() } as unknown as Logger;
}

describe("classifyInterventionTaskActivity", () => {
  it("classifies a hydrated running task without active execution as detached", () => {
    const task = makeTask({ hydratedFromDb: true });

    expect(classifyInterventionTaskActivity(task)).toBe("detached-hydrated-running");
  });

  it("keeps an in-memory running task active even when engine fields are not attached yet", () => {
    const task = makeTask();

    expect(classifyInterventionTaskActivity(task)).toBe("active-running");
  });

  it("keeps a hydrated running task active when an execution promise is still present", () => {
    const task = makeTask({
      hydratedFromDb: true,
      executionPromise: Promise.resolve(),
    });

    expect(classifyInterventionTaskActivity(task)).toBe("active-running");
  });

  it("classifies terminal statuses as auto-resume candidates", () => {
    const task = makeTask({ status: "interrupted" });

    expect(classifyInterventionTaskActivity(task)).toBe("terminal");
  });
});

describe("ActiveTaskRecovery", () => {
  it("coerces detached hydrated running tasks to interrupted before auto-resume", () => {
    const task = makeTask({ hydratedFromDb: true });
    const logger = makeLogger();
    const recovery = new ActiveTaskRecovery(logger);

    expect(recovery.prepareForIntervention(task)).toBe("auto-resume");
    expect(task.status).toBe("interrupted");
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(logger.warn).toHaveBeenCalledWith(
      { sessionId: "s1" },
      "hydrated running task has no active execution; auto-resuming instead of queueing",
    );
  });

  it("routes active running tasks to the running intervention path without mutation", () => {
    const task = makeTask();
    const logger = makeLogger();
    const recovery = new ActiveTaskRecovery(logger);

    expect(recovery.prepareForIntervention(task)).toBe("running");
    expect(task.status).toBe("running");
    expect(task.completedAt).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("routes terminal tasks to auto-resume without detached-running coercion", () => {
    const completedAt = new Date("2026-05-23T01:05:00.000Z");
    const task = makeTask({ status: "completed", completedAt });
    const logger = makeLogger();
    const recovery = new ActiveTaskRecovery(logger);

    expect(recovery.prepareForIntervention(task)).toBe("auto-resume");
    expect(task.status).toBe("completed");
    expect(task.completedAt).toBe(completedAt);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
