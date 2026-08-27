import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EnginePort } from "../../src/engine/protocol.js";
import { createInProcessTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import {
  TaskLifecycleRoute,
  type TaskLifecycleTransitionPort,
} from "../../src/task/task_lifecycle_route.js";
import { TaskLifecycleTransition } from
  "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeRoute(
  initialTasks: Task[] = [],
  onForget: (sessionId: string) => void = () => undefined,
  closeSessionRuntime?: (sessionId: string) => Promise<boolean>,
) {
  const tasks = new Map(initialTasks.map((task) => [task.agentSessionId, task]));
  const deleteSession = vi.fn().mockResolvedValue(undefined);

  const emitSessionDeleted = vi.fn().mockResolvedValue(undefined);
  const broadcaster = { emitSessionDeleted } as unknown as SessionBroadcaster;

  const lifecycleTransition = {
    cancelRunningTask: vi.fn().mockResolvedValue(true),
    interruptAndDrain: vi.fn().mockResolvedValue(undefined),
    markRunningTaskInterruptedForShutdown: vi.fn().mockResolvedValue(undefined),
    interruptForShutdown: vi.fn().mockResolvedValue(undefined),
    getDrainPromise: vi.fn().mockReturnValue(Promise.resolve()),
    finalizeExternalTask: vi.fn(async (task: Task) => task),
  } satisfies TaskLifecycleTransitionPort;

  const route = new TaskLifecycleRoute({
    getTask: (sessionId) => tasks.get(sessionId),
    listTasks: () => Array.from(tasks.values()),
    forgetTask: (sessionId) => {
      onForget(sessionId);
      tasks.delete(sessionId);
    },
    lifecycleTransition,
    sessionMutations: { deleteSession } as never,
    broadcaster,
    logger: silentLogger,
    closeSessionRuntime,
  });

  return {
    route,
    tasks,
    deleteSession,
    emitSessionDeleted,
    lifecycleTransition,
  };
}

describe("TaskLifecycleRoute.cancelTask", () => {
  it("looks up the task and delegates cancellation policy to TaskLifecycleTransition", async () => {
    const task = makeTask({ agentSessionId: "s1" });
    const { route, lifecycleTransition } = makeRoute([task]);

    await expect(route.cancelTask("s1")).resolves.toBe(true);

    expect(lifecycleTransition.cancelRunningTask).toHaveBeenCalledWith(task);
  });

  it("explicitly reclaims a completed session runtime without changing task status", async () => {
    const closeSessionRuntime = vi.fn().mockResolvedValue(true);
    const task = makeTask({ agentSessionId: "s1", status: "completed" });
    const { route, lifecycleTransition } = makeRoute(
      [task],
      () => undefined,
      closeSessionRuntime,
    );
    vi.mocked(lifecycleTransition.cancelRunningTask).mockResolvedValueOnce(false);

    await expect(route.cancelTask("s1")).resolves.toBe(true);

    expect(closeSessionRuntime).toHaveBeenCalledWith("s1", "explicit_cancel");
    expect(task.status).toBe("completed");
  });

  it("returns success for a converged completed task without the feature close seam", async () => {
    const task = makeTask({ agentSessionId: "s1", status: "completed" });
    const { route, lifecycleTransition } = makeRoute([task]);
    vi.mocked(lifecycleTransition.cancelRunningTask).mockResolvedValueOnce(false);

    await expect(route.cancelTask("s1")).resolves.toBe(true);
    expect(lifecycleTransition.cancelRunningTask).not.toHaveBeenCalled();
  });

  it("routes repeated stop through the real transition with one interrupt and persistence", async () => {
    const task = makeTask({ agentSessionId: "s1" });
    const interrupt = vi.fn().mockResolvedValue(true);
    const engine = { interrupt } as unknown as EnginePort;
    task.runner = createInProcessTaskRunnerRuntime(engine);
    const enqueueTerminalTransitionAndWaitForApplication = vi.fn(async (
      _sessionId: string,
      _event: unknown,
      effect: {
        status: string;
        termination_reason: string;
        termination_detail: string | null;
        review_state: string;
        updated_at: string;
      },
    ) => ({
      eventId: 8,
      applied: true,
      canonicalSession: {
        status: effect.status,
        termination_reason: effect.termination_reason,
        termination_detail: effect.termination_detail,
        review_state: effect.review_state,
        last_assistant_text: null,
        termination_event_id: 8,
        updated_at: effect.updated_at,
        last_event_id: 8,
      },
    }));
    const transition = new TaskLifecycleTransition({
      logger: silentLogger,
      persistence: { enqueueTerminalTransitionAndWaitForApplication } as never,
    });
    const tasks = new Map([[task.agentSessionId, task]]);
    const route = new TaskLifecycleRoute({
      getTask: (sessionId) => tasks.get(sessionId),
      listTasks: () => Array.from(tasks.values()),
      forgetTask: (sessionId) => { tasks.delete(sessionId); },
      lifecycleTransition: transition,
      sessionMutations: { deleteSession: vi.fn() } as never,
      broadcaster: { emitSessionDeleted: vi.fn() } as never,
      logger: silentLogger,
    });

    await expect(route.cancelTask("s1")).resolves.toBe(true);
    await expect(route.cancelTask("s1")).resolves.toBe(true);

    expect(interrupt).toHaveBeenCalledOnce();
    expect(enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledOnce();
    expect(task.runner).toBeUndefined();
    expect(task.executionPromise).toBeUndefined();
  });

  it("closes the V2 runtime before first stop success and does not close it again", async () => {
    const task = makeTask({ agentSessionId: "s1" });
    const interrupt = vi.fn().mockResolvedValue(true);
    const engine = { interrupt } as unknown as EnginePort;
    task.runner = createInProcessTaskRunnerRuntime(engine);
    const enqueueTerminalTransitionAndWaitForApplication = vi.fn(async (
      _sessionId: string,
      _event: unknown,
      effect: {
        status: string;
        termination_reason: string;
        termination_detail: string | null;
        review_state: string;
        updated_at: string;
      },
    ) => ({
      eventId: 8,
      applied: true,
      canonicalSession: {
        status: effect.status,
        termination_reason: effect.termination_reason,
        termination_detail: effect.termination_detail,
        review_state: effect.review_state,
        last_assistant_text: null,
        termination_event_id: 8,
        updated_at: effect.updated_at,
        last_event_id: 8,
      },
    }));
    const transition = new TaskLifecycleTransition({
      logger: silentLogger,
      persistence: { enqueueTerminalTransitionAndWaitForApplication } as never,
    });
    let runtimePresent = true;
    const hasSessionRuntime = vi.fn(() => runtimePresent);
    const closeSessionRuntime = vi.fn(async () => {
      runtimePresent = false;
      return true;
    });
    const deps = {
      getTask: () => task,
      listTasks: () => [task],
      forgetTask: vi.fn(),
      lifecycleTransition: transition,
      sessionMutations: { deleteSession: vi.fn() } as never,
      broadcaster: { emitSessionDeleted: vi.fn() } as never,
      logger: silentLogger,
      hasSessionRuntime,
      closeSessionRuntime,
    };
    const route = new TaskLifecycleRoute(deps);

    await expect(route.cancelTask("s1")).resolves.toBe(true);
    expect(closeSessionRuntime).toHaveBeenCalledOnce();
    expect(
      enqueueTerminalTransitionAndWaitForApplication.mock.invocationCallOrder[0],
    ).toBeLessThan(closeSessionRuntime.mock.invocationCallOrder[0]!);
    await expect(route.cancelTask("s1")).resolves.toBe(true);

    expect(interrupt).toHaveBeenCalledOnce();
    expect(enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledOnce();
    expect(closeSessionRuntime).toHaveBeenCalledOnce();
  });

  it("closes the V2 runtime once before a repeated stop_failed becomes success", async () => {
    const task = makeTask({ agentSessionId: "s1" });
    const interrupt = vi.fn().mockResolvedValue(false);
    const engine = { interrupt } as unknown as EnginePort;
    task.runner = createInProcessTaskRunnerRuntime(engine);
    const enqueueTerminalTransitionAndWaitForApplication = vi.fn(async (
      _sessionId: string,
      _event: unknown,
      effect: {
        status: string;
        termination_reason: string;
        termination_detail: string | null;
        review_state: string;
        updated_at: string;
      },
    ) => ({
      eventId: 8,
      applied: true,
      canonicalSession: {
        status: effect.status,
        termination_reason: effect.termination_reason,
        termination_detail: effect.termination_detail,
        review_state: effect.review_state,
        last_assistant_text: null,
        termination_event_id: 8,
        updated_at: effect.updated_at,
        last_event_id: 8,
      },
    }));
    const transition = new TaskLifecycleTransition({
      logger: silentLogger,
      persistence: { enqueueTerminalTransitionAndWaitForApplication } as never,
    });
    let runtimePresent = true;
    const closeSessionRuntime = vi.fn(async () => {
      runtimePresent = false;
      return true;
    });
    const route = new TaskLifecycleRoute({
      getTask: () => task,
      listTasks: () => [task],
      forgetTask: vi.fn(),
      lifecycleTransition: transition,
      sessionMutations: { deleteSession: vi.fn() } as never,
      broadcaster: { emitSessionDeleted: vi.fn() } as never,
      logger: silentLogger,
      hasSessionRuntime: () => runtimePresent,
      closeSessionRuntime,
    });

    await expect(route.cancelTask("s1")).resolves.toBe(false);
    await expect(route.cancelTask("s1")).resolves.toBe(true);

    expect(interrupt).toHaveBeenCalledOnce();
    expect(enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledOnce();
    expect(closeSessionRuntime).toHaveBeenCalledOnce();
    expect(task.interventionQueue).toEqual([]);
  });
});

describe("TaskLifecycleRoute.deleteTask", () => {
  it("interrupts and drains before forgetting the task, then deletes DB row and broadcasts", async () => {
    const events: string[] = [];
    const task = makeTask({ agentSessionId: "s1" });
    const {
      route,
      tasks,
      deleteSession,
      emitSessionDeleted,
      lifecycleTransition,
    } = makeRoute(
      [task],
      () => {
        events.push("forget");
      },
      async () => {
        events.push("close-runtime");
        return true;
      },
    );
    vi.mocked(lifecycleTransition.interruptAndDrain).mockImplementationOnce(async () => {
      events.push("interrupt");
    });
    deleteSession.mockImplementationOnce(async () => {
      events.push("delete");
    });
    emitSessionDeleted.mockImplementationOnce(async () => {
      events.push("broadcast");
    });

    await route.deleteTask("s1");

    expect(tasks.has("s1")).toBe(false);
    expect(lifecycleTransition.interruptAndDrain).toHaveBeenCalledWith(task);
    expect(deleteSession).toHaveBeenCalledWith("s1", "delete_session:s1");
    expect(emitSessionDeleted).toHaveBeenCalledWith("s1");
    expect(events).toEqual([
      "interrupt",
      "close-runtime",
      "delete",
      "forget",
      "broadcast",
    ]);
  });

  it("treats missing sessions as no-op and retains the task when host deletion fails", async () => {
    const task = makeTask({ agentSessionId: "s1" });
    const { route, tasks, deleteSession, emitSessionDeleted } = makeRoute([task]);
    deleteSession.mockRejectedValueOnce(new Error("db down"));
    await expect(route.deleteTask("missing")).resolves.toBeUndefined();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(emitSessionDeleted).not.toHaveBeenCalled();

    await expect(route.deleteTask("s1")).rejects.toThrow("db down");
    expect(tasks.has("s1")).toBe(true);
    expect(deleteSession).toHaveBeenCalledWith("s1", "delete_session:s1");
    expect(emitSessionDeleted).not.toHaveBeenCalled();
  });
});

describe("TaskLifecycleRoute.shutdown", () => {
  it("detaches process runners without interrupting or marking their sessions terminal", async () => {
    const detachHost = vi.fn(async () => {});
    const processTask = makeTask({
      runner: {
        engine: {} as EnginePort,
        dispatcher: { detachHost } as never,
        eventPersistence: "runner",
      },
      runnerRetainedForClaudeBackground: true,
      executionPromise: new Promise<void>(() => {}),
    });
    const { route, lifecycleTransition } = makeRoute([processTask]);

    await route.shutdown();

    expect(detachHost).toHaveBeenCalledOnce();
    expect(processTask.status).toBe("running");
    expect(processTask.runner).toBeUndefined();
    expect(processTask.runnerRetainedForClaudeBackground).toBeUndefined();
    expect(processTask.executionPromise).toBeUndefined();
    expect(lifecycleTransition.markRunningTaskInterruptedForShutdown).not.toHaveBeenCalled();
    expect(lifecycleTransition.interruptForShutdown).not.toHaveBeenCalled();
  });

  it("marks running tasks, interrupts every task, and collects drains only for tasks that had engines", async () => {
    const running = makeTask({ agentSessionId: "running" });
    const terminalWithEngine = makeTask({
      agentSessionId: "terminal",
      status: "completed",
    });
    const noEngine = makeTask({ agentSessionId: "no-engine" });
    running.runner = createInProcessTaskRunnerRuntime(
      { interrupt: vi.fn() } as unknown as EnginePort,
    );
    terminalWithEngine.runner = createInProcessTaskRunnerRuntime(
      { interrupt: vi.fn() } as unknown as EnginePort,
    );
    const { route, lifecycleTransition } = makeRoute([
      running,
      terminalWithEngine,
      noEngine,
    ]);

    await route.shutdown();

    expect(
      lifecycleTransition.markRunningTaskInterruptedForShutdown,
    ).toHaveBeenCalledTimes(2);
    expect(lifecycleTransition.markRunningTaskInterruptedForShutdown).toHaveBeenCalledWith(
      running,
      expect.any(Date),
    );
    expect(lifecycleTransition.markRunningTaskInterruptedForShutdown).toHaveBeenCalledWith(
      noEngine,
      expect.any(Date),
    );
    expect(lifecycleTransition.interruptForShutdown).toHaveBeenCalledWith(running);
    expect(lifecycleTransition.interruptForShutdown).toHaveBeenCalledWith(terminalWithEngine);
    expect(lifecycleTransition.interruptForShutdown).toHaveBeenCalledWith(noEngine);
    expect(lifecycleTransition.getDrainPromise).toHaveBeenCalledTimes(2);
    expect(lifecycleTransition.getDrainPromise).toHaveBeenCalledWith(running);
    expect(lifecycleTransition.getDrainPromise).toHaveBeenCalledWith(terminalWithEngine);
  });
});

describe("TaskLifecycleRoute.finalizeTask", () => {
  it("validates public input, returns undefined for missing tasks, and delegates final state mutation", async () => {
    const task = makeTask({ agentSessionId: "s1" });
    const { route, lifecycleTransition } = makeRoute([task]);

    await expect(route.finalizeTask({ agentSessionId: "s1" })).rejects.toThrow(
      /requires either result or error/,
    );
    await expect(route.finalizeTask({
      agentSessionId: "missing",
      result: "done",
    })).resolves.toBeUndefined();

    await expect(route.finalizeTask({
      agentSessionId: "s1",
      result: "done",
    })).resolves.toBe(task);
    expect(lifecycleTransition.finalizeExternalTask).toHaveBeenCalledWith(task, {
      result: "done",
    });
  });
});
