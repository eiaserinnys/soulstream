import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { ActiveTaskRecovery } from "../../src/task/task_active_recovery.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import type { Task } from "../../src/task/task_models.js";
import type { RunningInterventionTransition } from "../../src/task/task_running_intervention_transition.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-intervention",
    prompt: "original prompt",
    status: "running",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 3,
    interventionQueue: [],
    ...overrides,
  };
}

function makeLogger(): Logger {
  return { warn: vi.fn() } as unknown as Logger;
}

function makeSubject(initialTasks: Task[] = []) {
  const tasks = new Map(initialTasks.map((task) => [task.agentSessionId, task]));
  const logger = makeLogger();
  const loadEvictedTask = vi.fn(async (_sessionId: string): Promise<Task | null> => null);
  const runningInterventionTransition = {
    deliver: vi.fn().mockResolvedValue({ queued: true, queuePosition: 1 }),
  } as unknown as Pick<RunningInterventionTransition, "deliver">;
  const autoResumeTransition = {
    resume: vi.fn().mockResolvedValue({ autoResumed: true }),
  } as unknown as Pick<AutoResumeTransition, "resume">;
  const route = new TaskInterventionRoute({
    getTask: (sessionId) => tasks.get(sessionId),
    loadEvictedTask,
    rememberTask: (task) => {
      tasks.set(task.agentSessionId, task);
    },
    activeTaskRecovery: new ActiveTaskRecovery(logger),
    runningInterventionTransition,
    autoResumeTransition,
  });

  return {
    route,
    tasks,
    loadEvictedTask,
    runningInterventionTransition,
    autoResumeTransition,
  };
}

describe("TaskInterventionRoute.addIntervention", () => {
  it("routes memory-hit running tasks to the running transition and preserves public result shape", async () => {
    const task = makeTask();
    const { route, loadEvictedTask, runningInterventionTransition, autoResumeTransition } =
      makeSubject([task]);
    const onResume = vi.fn();
    const context = [
      { key: "supervisor", label: "Supervisor", content: "fresh context" },
    ];

    await expect(route.addIntervention({
      agentSessionId: "sess-intervention",
      text: "focus on the failing test",
      user: "alice",
      callerInfo: { source: "slack", display_name: "Alice" },
      attachmentPaths: ["/tmp/a.png"],
      context,
    }, onResume)).resolves.toEqual({ queued: true, queuePosition: 1 });

    expect(loadEvictedTask).not.toHaveBeenCalled();
    expect(runningInterventionTransition.deliver).toHaveBeenCalledWith(task, {
      text: "focus on the failing test",
      user: "alice",
      callerInfo: { source: "slack", display_name: "Alice" },
      attachmentPaths: ["/tmp/a.png"],
      context,
    }, {
      queueIfUndelivered: true,
    });
    expect(autoResumeTransition.resume).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("routes memory-hit terminal tasks to auto-resume and forwards onResume only there", async () => {
    const task = makeTask({
      status: "completed",
      completedAt: new Date("2026-05-23T01:05:00.000Z"),
    });
    const { route, runningInterventionTransition, autoResumeTransition } = makeSubject([task]);
    const onResume = vi.fn();

    await expect(route.addIntervention({
      agentSessionId: "sess-intervention",
      text: "resume",
      user: "alice",
      source: "claude_runtime_task_followup",
      followupAttempt: 2,
      followupKey: "sess-intervention:agent-task",
      followupTaskIds: ["agent-task"],
      onlyIfTerminal: true,
    }, onResume)).resolves.toEqual({ autoResumed: true });

    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(autoResumeTransition.resume).toHaveBeenCalledWith(task, {
      text: "resume",
      user: "alice",
      callerInfo: undefined,
      attachmentPaths: undefined,
      context: undefined,
      source: "claude_runtime_task_followup",
      followupAttempt: 2,
      followupKey: "sess-intervention:agent-task",
      followupTaskIds: ["agent-task"],
    }, onResume);
  });

  it("terminal-only delivery never enters the running intervention path", async () => {
    const task = makeTask({ status: "running" });
    const { route, runningInterventionTransition, autoResumeTransition } = makeSubject([task]);

    await expect(route.addIntervention({
      agentSessionId: "sess-intervention",
      text: "delayed background follow-up retry",
      user: "system",
      source: "claude_runtime_task_followup",
      onlyIfTerminal: true,
    }, vi.fn())).resolves.toEqual({ deferred: true });

    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(autoResumeTransition.resume).not.toHaveBeenCalled();
  });

  it("loads and remembers evicted terminal tasks before auto-resume route selection", async () => {
    const hydrated = makeTask({
      agentSessionId: "sess-evicted",
      status: "completed",
      hydratedFromDb: true,
      codexThreadId: "thr-1",
      profileId: "codex-default",
    });
    const { route, tasks, loadEvictedTask, autoResumeTransition } = makeSubject();
    loadEvictedTask.mockResolvedValueOnce(hydrated);
    const onResume = vi.fn();

    await expect(route.addIntervention({
      agentSessionId: "sess-evicted",
      text: "resume from DB",
      user: "alice",
    }, onResume)).resolves.toEqual({ autoResumed: true });

    expect(loadEvictedTask).toHaveBeenCalledWith("sess-evicted");
    expect(tasks.get("sess-evicted")).toBe(hydrated);
    expect(autoResumeTransition.resume).toHaveBeenCalledWith(hydrated, expect.objectContaining({
      text: "resume from DB",
    }), onResume);
  });

  it("treats detached hydrated running tasks as auto-resume instead of running queue", async () => {
    const hydrated = makeTask({
      agentSessionId: "sess-stale-running",
      status: "running",
      hydratedFromDb: true,
      codexThreadId: "thr-stale",
    });
    const { route, tasks, loadEvictedTask, runningInterventionTransition, autoResumeTransition } =
      makeSubject();
    loadEvictedTask.mockResolvedValueOnce(hydrated);

    await expect(route.addIntervention({
      agentSessionId: "sess-stale-running",
      text: "resume stale running",
      user: "alice",
    }, vi.fn())).resolves.toEqual({ autoResumed: true });

    expect(tasks.get("sess-stale-running")).toBe(hydrated);
    expect(hydrated.status).toBe("interrupted");
    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(autoResumeTransition.resume).toHaveBeenCalledWith(hydrated, expect.objectContaining({
      text: "resume stale running",
    }), expect.any(Function));
  });

  it("normalizes unresolved task lookup to the existing Task not found error shape", async () => {
    const { route, loadEvictedTask, runningInterventionTransition, autoResumeTransition } =
      makeSubject();
    loadEvictedTask.mockResolvedValueOnce(null);

    await expect(route.addIntervention({
      agentSessionId: "missing",
      text: "x",
      user: "alice",
    }, vi.fn())).rejects.toThrow("Task not found: missing");

    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(autoResumeTransition.resume).not.toHaveBeenCalled();
  });
});
